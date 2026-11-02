import { assertRunnable } from "./catalog.ts";
import { ChefInputError, ChefTimeoutError } from "./errors.ts";
import { bake, bakeTimeoutMs, magic, magicTimeoutMs } from "./execute.ts";
import type { EncodedOutput, InputEncoding, RecipeStep } from "./protocol.ts";

const UNDO_OPERATIONS = [
  "From Base64",
  "From Base32",
  "From Base58",
  "From Hex",
  "URL Decode",
  "From Quoted Printable",
  "Gunzip",
  "Zlib Inflate",
  "Raw Inflate",
] as const;

const BRUTE_OPERATIONS = ["XOR Brute Force", "ROT13 Brute Force"] as const;

const CRIB_ARGUMENT = "Crib (known plaintext string)";

export type MagicSettings = {
  depth: number;
  intensive: boolean;
  languageSupport: boolean;
  crib: string;
};

export type Attempt =
  | { kind: "magic"; recipe: RecipeStep[] }
  | { kind: "bake-then-magic"; recipe: RecipeStep[]; step?: RecipeStep }
  | { kind: "brute"; recipe: RecipeStep[]; step: RecipeStep };

export type SpecialistCandidate = {
  rank: number;
  recipe: RecipeStep[];
  output: string;
  encoding: "utf8" | "base64";
  type: string;
  matchedCrib: boolean;
};

export type SpecialistResult = EncodedOutput & {
  hit: boolean;
  reason: "crib" | "local";
  recipe: RecipeStep[];
  candidates: SpecialistCandidate[];
};

export type Collected = {
  recipe: RecipeStep[];
  output: string;
  encoding: "utf8" | "base64";
  type: string;
  matchedCrib: boolean;
  order: number;
};

type Produced = {
  recipe: RecipeStep[];
  output: string;
  encoding: "utf8" | "base64";
  type: string;
};

type Stage = {
  input: string;
  inputEncoding: InputEncoding;
};

export type LadderRequest = {
  input: string;
  inputEncoding: InputEncoding;
  prefix?: RecipeStep[];
  depth?: number;
  intensive?: boolean;
  languageSupport?: boolean;
  crib?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  now?: () => number;
};

export type LadderRunners = {
  bake: (
    input: string,
    recipe: RecipeStep[],
    inputEncoding: InputEncoding,
    timeoutMs: number,
  ) => Promise<EncodedOutput>;
  magic: (
    input: string,
    options: MagicSettings & { inputEncoding: InputEncoding; timeoutMs: number },
  ) => Promise<EncodedOutput>;
};

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function specialistTimeoutMs(): number {
  return positiveEnv("CYBERCHEF_SPECIALIST_TIMEOUT_MS", 180_000);
}

function cloneStep(step: RecipeStep): RecipeStep {
  const cloned: RecipeStep = { op: step.op };
  if ("args" in step) cloned.args = step.args;
  return cloned;
}

function magicStep(settings: MagicSettings): RecipeStep {
  return {
    op: "Magic",
    args: [settings.depth, settings.intensive, settings.languageSupport, settings.crib],
  };
}

function bruteStep(op: string, crib: string): RecipeStep {
  return { op, args: { [CRIB_ARGUMENT]: crib } };
}

export function normalisePrefix(prefix: RecipeStep[] | undefined): RecipeStep[] {
  if (!prefix || prefix.length === 0) return [];
  return prefix.map((step) => {
    if (!step || typeof step.op !== "string" || step.op.trim().length === 0) {
      throw new ChefInputError("Each prefix step needs an operation name.");
    }
    const operation = assertRunnable(step.op);
    const saved: RecipeStep = { op: operation.name };
    if ("args" in step) saved.args = step.args;
    return saved;
  });
}

export function buildAttempts(prefix: RecipeStep[], settings: MagicSettings): Attempt[] {
  const head = prefix.map(cloneStep);
  const magic = magicStep(settings);
  const last = head.at(-1)?.op;
  const attempts: Attempt[] = [];
  if (head.length === 0) {
    attempts.push({ kind: "magic", recipe: [magic] });
  } else {
    attempts.push({ kind: "bake-then-magic", recipe: [...head, magic] });
  }
  for (const op of UNDO_OPERATIONS) {
    if (op === last) continue;
    const step: RecipeStep = { op };
    attempts.push({ kind: "bake-then-magic", recipe: [...head, step, magic], step });
  }
  for (const op of BRUTE_OPERATIONS) {
    const step = bruteStep(op, settings.crib);
    attempts.push({ kind: "brute", recipe: [...head, step], step });
  }
  return attempts;
}

export function outputMatchesCrib(output: string, crib: string): boolean {
  if (crib.trim() === "") return false;
  if (output.includes(crib)) return true;
  try {
    const sample = output.length > 100_000 ? output.slice(0, 100_000) : output;
    return new RegExp(crib).test(sample);
  } catch {
    return false;
  }
}

function stageEncoding(result: EncodedOutput): InputEncoding {
  return result.encoding === "base64" ? "base64" : "utf8";
}

function settingsFrom(request: LadderRequest): MagicSettings {
  const depth = request.depth ?? 3;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new ChefInputError("depth must be an integer of at least 0.");
  }
  return {
    depth,
    intensive: request.intensive ?? false,
    languageSupport: request.languageSupport ?? false,
    crib: request.crib ?? "",
  };
}

function emptyResult(): SpecialistResult {
  return {
    output: "",
    encoding: "utf8",
    type: "unknown",
    hit: false,
    reason: "local",
    recipe: [],
    candidates: [],
  };
}

function rankLocally(items: Collected[], input: string): Collected[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.matchedCrib !== right.item.matchedCrib) return left.item.matchedCrib ? -1 : 1;
      const leftText = left.item.encoding === "utf8" && left.item.output !== input;
      const rightText = right.item.encoding === "utf8" && right.item.output !== input;
      if (leftText !== rightText) return leftText ? -1 : 1;
      return left.item.order - right.item.order;
    })
    .map(({ item }) => item);
}

export async function rankCandidates(
  items: Collected[],
  options: { input: string },
): Promise<{ reason: "crib" | "local"; ordered: Collected[] }> {
  const ordered = rankLocally(items, options.input);
  return { reason: ordered.some((item) => item.matchedCrib) ? "crib" : "local", ordered };
}

function present(ranked: { reason: "crib" | "local"; ordered: Collected[] }): SpecialistResult {
  const candidates: SpecialistCandidate[] = ranked.ordered.map((item, index) => ({
    rank: index + 1,
    recipe: item.recipe,
    output: item.output,
    encoding: item.encoding,
    type: item.type,
    matchedCrib: item.matchedCrib,
  }));
  const winner = candidates[0];
  if (!winner) return emptyResult();
  return {
    output: winner.output,
    encoding: winner.encoding,
    type: winner.type,
    hit: ranked.reason === "crib",
    reason: ranked.reason,
    recipe: winner.recipe,
    candidates,
  };
}

async function runAttempt(
  attempt: Attempt,
  current: Stage,
  settings: MagicSettings,
  runners: LadderRunners,
  take: (cap: number) => number | undefined,
  bakeCap: number,
  magicCap: number,
): Promise<Produced | "timeout" | "skip"> {
  switch (attempt.kind) {
    case "magic": {
      const timeoutMs = take(magicCap);
      if (timeoutMs === undefined) return "timeout";
      try {
        const result = await runners.magic(current.input, {
          inputEncoding: current.inputEncoding,
          depth: settings.depth,
          intensive: settings.intensive,
          languageSupport: settings.languageSupport,
          crib: settings.crib,
          timeoutMs,
        });
        return { recipe: attempt.recipe, output: result.output, encoding: result.encoding, type: result.type };
      } catch (error) {
        if (error instanceof ChefTimeoutError) return "timeout";
        return "skip";
      }
    }
    case "bake-then-magic": {
      let source = current;
      if (attempt.step) {
        const timeoutMs = take(bakeCap);
        if (timeoutMs === undefined) return "timeout";
        try {
          const baked = await runners.bake(current.input, [attempt.step], current.inputEncoding, timeoutMs);
          source = { input: baked.output, inputEncoding: stageEncoding(baked) };
        } catch (error) {
          if (error instanceof ChefTimeoutError) return "timeout";
          return "skip";
        }
      }
      const timeoutMs = take(magicCap);
      if (timeoutMs === undefined) return "timeout";
      try {
        const result = await runners.magic(source.input, {
          inputEncoding: source.inputEncoding,
          depth: settings.depth,
          intensive: settings.intensive,
          languageSupport: settings.languageSupport,
          crib: settings.crib,
          timeoutMs,
        });
        return { recipe: attempt.recipe, output: result.output, encoding: result.encoding, type: result.type };
      } catch (error) {
        if (error instanceof ChefTimeoutError) return "timeout";
        return "skip";
      }
    }
    case "brute": {
      const timeoutMs = take(bakeCap);
      if (timeoutMs === undefined) return "timeout";
      try {
        const result = await runners.bake(current.input, [attempt.step], current.inputEncoding, timeoutMs);
        return { recipe: attempt.recipe, output: result.output, encoding: result.encoding, type: result.type };
      } catch (error) {
        if (error instanceof ChefTimeoutError) return "timeout";
        return "skip";
      }
    }
    default: {
      const unknown: never = attempt;
      throw new Error(`Unknown specialist attempt: ${JSON.stringify(unknown)}`);
    }
  }
}

export async function runLadder(request: LadderRequest, runners: LadderRunners): Promise<SpecialistResult> {
  const prefix = normalisePrefix(request.prefix);
  const settings = settingsFrom(request);
  const attempts = buildAttempts(prefix, settings);
  const maxAttempts = request.maxAttempts ?? attempts.length;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ChefInputError("maxAttempts must be an integer of at least 1.");
  }
  const budget = request.timeoutMs ?? specialistTimeoutMs();
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new ChefInputError("timeoutMs must be greater than 0.");
  }
  const now = request.now ?? Date.now;
  const deadline = now() + budget;
  const bakeCap = bakeTimeoutMs();
  const magicCap = magicTimeoutMs();
  const take = (cap: number): number | undefined => {
    const left = Math.floor(deadline - now());
    if (left <= 0) return undefined;
    return Math.min(cap, left);
  };

  let current: Stage = { input: request.input, inputEncoding: request.inputEncoding };
  if (prefix.length > 0) {
    const timeoutMs = take(bakeCap);
    if (timeoutMs === undefined) return emptyResult();
    const prefixed = await runners.bake(current.input, prefix, current.inputEncoding, timeoutMs);
    current = { input: prefixed.output, inputEncoding: stageEncoding(prefixed) };
  }

  const collected: Collected[] = [];
  for (const attempt of attempts.slice(0, maxAttempts)) {
    const produced = await runAttempt(attempt, current, settings, runners, take, bakeCap, magicCap);
    if (produced === "timeout") break;
    if (produced === "skip") continue;
    const matchedCrib = outputMatchesCrib(produced.output, settings.crib);
    collected.push({ ...produced, matchedCrib, order: collected.length });
    if (matchedCrib) break;
  }

  return present(await rankCandidates(collected, { input: request.input }));
}

export async function specialist(
  input: string,
  options?: {
    inputEncoding?: InputEncoding;
    prefix?: RecipeStep[];
    depth?: number;
    intensive?: boolean;
    languageSupport?: boolean;
    crib?: string;
    maxAttempts?: number;
    timeoutMs?: number;
  },
): Promise<SpecialistResult> {
  return runLadder({
    input,
    inputEncoding: options?.inputEncoding ?? "utf8",
    prefix: options?.prefix,
    depth: options?.depth,
    intensive: options?.intensive,
    languageSupport: options?.languageSupport,
    crib: options?.crib,
    maxAttempts: options?.maxAttempts,
    timeoutMs: options?.timeoutMs,
  }, {
    bake: (value, recipe, encoding, timeoutMs) => bake(value, recipe, encoding, { timeoutMs }),
    magic: (value, magicOptions) => magic(value, magicOptions),
  });
}
