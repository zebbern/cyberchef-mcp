import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { shutdownWorkers } from "../src/execute.ts";
import { createChefServer } from "../src/server.ts";

const HEX_TEXT = "64 47 56 7a 64 41 3d 3d";

after(async () => {
  await shutdownWorkers();
});

async function session(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createChefServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cyberchef-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? "";
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("file input and output", { concurrency: 1 }, () => {
  test("bake reads a file and writes the raw output", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cyberchef-file-"));
    const inputPath = path.join(dir, "in.txt");
    const outputPath = path.join(dir, "out.txt");
    writeFileSync(inputPath, HEX_TEXT);
    const connected = await session();
    try {
      const baked = await callJson(connected.client, "bake", {
        inputPath,
        outputPath,
        recipe: [
          { op: "From Hex", args: ["Auto"] },
          { op: "From Base64", args: ["A-Za-z0-9+/=", true, false] },
        ],
      });
      assert.equal(baked.output, "test");
      assert.equal(readFileSync(outputPath, "utf8"), "test");
      assert.equal(baked.outputPath, outputPath);
    } finally {
      await connected.close();
    }
  });

  test("a saved binary file is the raw bytes, not the base64 text", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cyberchef-gzip-"));
    const inputPath = path.join(dir, "plain.txt");
    const outputPath = path.join(dir, "plain.gz");
    writeFileSync(inputPath, "test");
    const connected = await session();
    try {
      const baked = await callJson(connected.client, "run_operation", {
        name: "Gzip",
        inputPath,
        outputPath,
      });
      assert.equal(baked.encoding, "base64");
      const bytes = readFileSync(outputPath);
      assert.equal(bytes[0], 0x1f);
      assert.equal(bytes[1], 0x8b);
      assert.equal(bytes.toString("utf8").includes("H4sI"), false);
    } finally {
      await connected.close();
    }
  });

  test("a folder is baked file by file into an output folder", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cyberchef-folder-"));
    const inputPath = path.join(dir, "in");
    const outputPath = path.join(dir, "out");
    mkdirSync(path.join(inputPath, "nested"), { recursive: true });
    writeFileSync(path.join(inputPath, "one.txt"), "one");
    writeFileSync(path.join(inputPath, "nested", "two.txt"), "two");
    const connected = await session();
    try {
      const baked = await callJson(connected.client, "bake", {
        inputPath,
        outputPath,
        recipe: [],
      });
      const files = baked.files as { inputPath: string; outputPath: string }[];
      assert.equal(files.length, 2);
      assert.equal(readFileSync(path.join(outputPath, "one.txt"), "utf8"), "one");
      assert.equal(readFileSync(path.join(outputPath, "nested", "two.txt"), "utf8"), "two");
    } finally {
      await connected.close();
    }
  });

  test("input and inputPath together are rejected", { timeout: 180_000 }, async () => {
    const connected = await session();
    try {
      const result = await connected.client.callTool({
        name: "bake",
        arguments: { input: "a", inputPath: "b", recipe: [] },
      });
      assert.equal(result.isError, true);
      const text = (result.content as { text?: string }[])[0]?.text ?? "";
      assert.match(text, /input or inputPath/);
    } finally {
      await connected.close();
    }
  });
});
