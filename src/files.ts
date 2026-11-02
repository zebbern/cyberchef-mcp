import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChefInputError } from "./errors.ts";
import { normaliseEncoding } from "./execute.ts";
import type { EncodedOutput, InputEncoding } from "./protocol.ts";

const MAX_FOLDER_FILES = 200;

export type SavedOutput = EncodedOutput & {
  inputPath?: string;
  outputPath?: string;
  byteLength?: number;
};

export type FolderOutput = {
  inputPath: string;
  outputPath?: string;
  files: SavedOutput[];
  truncated?: boolean;
  remainingFiles?: number;
};

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function folderBudgetMs(): number {
  return positiveEnv("CYBERCHEF_FOLDER_TIMEOUT_MS", 600_000);
}

function rawBytes(result: EncodedOutput): Buffer {
  if (result.encoding === "base64") return Buffer.from(result.output, "base64");
  return Buffer.from(result.output, "utf8");
}

async function writeRaw(result: EncodedOutput, destination: string): Promise<number> {
  const bytes = rawBytes(result);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return bytes.length;
}

async function filesIn(root: string): Promise<{ absolute: string; relative: string }[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: { absolute: string; relative: string }[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    files.push({ absolute, relative });
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  if (files.length === 0) throw new ChefInputError(`Folder has no files: ${root}`);
  if (files.length > MAX_FOLDER_FILES) {
    throw new ChefInputError(`Folder has ${files.length} files. The limit is ${MAX_FOLDER_FILES}.`);
  }
  return files;
}

async function runBytes(
  bytes: Buffer,
  run: (input: string, encoding: InputEncoding) => Promise<EncodedOutput>,
): Promise<EncodedOutput> {
  return run(bytes.toString("base64"), "base64");
}

export async function runAcrossInput(spec: {
  input?: string;
  inputEncoding?: unknown;
  inputPath?: string;
  outputPath?: string;
  run: (input: string, encoding: InputEncoding) => Promise<EncodedOutput>;
}): Promise<SavedOutput | FolderOutput> {
  const inputPath = spec.inputPath?.trim() ? path.resolve(spec.inputPath.trim()) : undefined;
  const outputPath = spec.outputPath?.trim() ? path.resolve(spec.outputPath.trim()) : undefined;
  const hasInput = spec.input !== undefined;
  if (hasInput === Boolean(inputPath)) {
    throw new ChefInputError("Provide input or inputPath, not both.");
  }

  if (!inputPath) {
    const result = await spec.run(spec.input ?? "", normaliseEncoding(spec.inputEncoding));
    if (!outputPath) return result;
    const outputInfo = await stat(outputPath).catch(() => undefined);
    if (outputInfo?.isDirectory()) {
      throw new ChefInputError("outputPath is a folder. Pass a file path when the input is not a folder.");
    }
    const byteLength = await writeRaw(result, outputPath);
    return { ...result, outputPath, byteLength };
  }

  const info = await stat(inputPath).catch(() => {
    throw new ChefInputError(`Cannot open input path: ${inputPath}`);
  });

  if (info.isDirectory()) {
    if (outputPath) {
      const outputInfo = await stat(outputPath).catch(() => undefined);
      if (outputInfo?.isFile()) {
        throw new ChefInputError("outputPath is a file. Pass a folder when the input is a folder.");
      }
      await mkdir(outputPath, { recursive: true });
    }
    const allFiles = await filesIn(inputPath);
    const deadline = Date.now() + folderBudgetMs();
    const files: SavedOutput[] = [];
    let processed = 0;
    while (processed < allFiles.length && Date.now() < deadline) {
      const file = allFiles[processed];
      const result = await runBytes(await readFile(file.absolute), spec.run);
      const destination = outputPath ? path.join(outputPath, file.relative) : undefined;
      const byteLength = destination ? await writeRaw(result, destination) : undefined;
      files.push({
        ...result,
        inputPath: file.absolute,
        outputPath: destination,
        byteLength,
      });
      processed += 1;
    }
    const remainingFiles = allFiles.length - processed;
    return remainingFiles > 0
      ? { inputPath, outputPath, files, truncated: true, remainingFiles }
      : { inputPath, outputPath, files };
  }

  if (!info.isFile()) throw new ChefInputError(`Input path is not a file or folder: ${inputPath}`);
  const result = await runBytes(await readFile(inputPath), spec.run);
  if (!outputPath) return { ...result, inputPath };
  const outputInfo = await stat(outputPath).catch(() => undefined);
  if (outputInfo?.isDirectory()) {
    throw new ChefInputError("outputPath is a folder. Pass a file path when the input is a file.");
  }
  const byteLength = await writeRaw(result, outputPath);
  return { ...result, inputPath, outputPath, byteLength };
}
