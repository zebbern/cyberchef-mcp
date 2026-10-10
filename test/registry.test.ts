import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findCategory, toolNameFor } from "../src/catalog.ts";
import { shutdownWorkers } from "../src/execute.ts";
import { ALWAYS_ON_TOOLS } from "../src/registry.ts";
import { createChefServer } from "../src/server.ts";

after(async () => {
  await shutdownWorkers();
});

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
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

async function toolNames(client: Client): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    names.push(...page.tools.map((tool) => tool.name));
    cursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
  } while (cursor);
  return names;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? "";
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text);
}

describe("registry", { concurrency: 1 }, () => {
  test("enable_category mounts slugs and disable_category removes only those tools", { timeout: 180_000 }, async () => {
    const category = findCategory("Language");
    assert.ok(category);
    assert.ok(category.operations.length > 0);
    const session = await connect();
    try {
      const enabled = await callJson(session.client, "enable_category", { category: "language" }) as { mounted: string[] };
      assert.equal(enabled.mounted.length, category.operations.length);
      for (const operation of category.operations) {
        assert.ok(enabled.mounted.includes(toolNameFor(operation.name)));
      }
      let names = await toolNames(session.client);
      for (const toolName of enabled.mounted) assert.ok(names.includes(toolName), toolName);
      for (const toolName of ALWAYS_ON_TOOLS) assert.ok(names.includes(toolName), toolName);

      const disabled = await callJson(session.client, "disable_category", { category: "Language" }) as { removed: string[] };
      assert.equal(disabled.removed.length, enabled.mounted.length);
      names = await toolNames(session.client);
      for (const toolName of enabled.mounted) assert.equal(names.includes(toolName), false, toolName);
      for (const toolName of ALWAYS_ON_TOOLS) assert.ok(names.includes(toolName), toolName);
      assert.deepEqual(names.filter((name) => name.startsWith("cc_")), []);

      const run = await callJson(session.client, "run_operation", {
        name: "Remove Diacritics",
        input: "hi",
      }) as { output: string; encoding: string; type: string };
      assert.equal(run.encoding, "utf8");
      assert.equal(run.output, "hi");
    } finally {
      await session.close();
    }
  });

  test("enable_operations mounts only the named tool", { timeout: 180_000 }, async () => {
    const session = await connect();
    try {
      const enabled = await callJson(session.client, "enable_operations", { names: ["To Upper case"] }) as { mounted: string[] };
      const expected = toolNameFor("To Upper case");
      assert.deepEqual(enabled.mounted, [expected]);
      const names = await toolNames(session.client);
      assert.deepEqual(names.filter((name) => name.startsWith("cc_")), [expected]);
      for (const toolName of ALWAYS_ON_TOOLS) assert.ok(names.includes(toolName));
      const run = await callJson(session.client, "run_operation", { name: "To Upper case", input: "ab" }) as { output: string };
      assert.equal(run.output, "AB");
    } finally {
      await session.close();
    }
  });
});
