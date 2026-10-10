import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  categoriesFilePath,
  describeOperation,
  listCategories,
  readCategories,
  searchOperations,
} from "../src/catalog.ts";
import { chefArgToZod } from "../src/schema.ts";
import { createChefServer } from "../src/server.ts";
import { shutdownWorkers } from "../src/execute.ts";

after(async () => {
  await shutdownWorkers();
});

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createChefServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cyberchef-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("catalog", { concurrency: 1 }, () => {
  test("category and operation counts match Categories.json", () => {
    const filePath = categoriesFilePath();
    const raw = readCategories(filePath);
    const listed = listCategories();
    assert.equal(listed.length, raw.length);
    const expectedOps = raw.reduce((sum, category) => sum + category.operations.length, 0);
    const actualOps = listed.reduce((sum, category) => sum + category.operationCount, 0);
    assert.equal(actualOps, expectedOps);
    assert.ok(filePath.endsWith("Categories.json"));
  });

  test("list_categories matches Data Format without case sensitivity", async () => {
    const fromRaw = readCategories(categoriesFilePath()).find((category) => category.name === "Data format");
    assert.ok(fromRaw);
    const listed = listCategories("Data Format");
    assert.deepEqual(listed, [{ name: "Data format", operationCount: fromRaw.operations.length }]);

    await withClient(async (client) => {
      const result = await client.callTool({ name: "list_categories", arguments: { name: "Data Format" } });
      assert.notEqual(result.isError, true);
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      const body = JSON.parse(text) as { categories: { name: string; operationCount: number }[] };
      assert.deepEqual(body.categories, [{ name: "Data format", operationCount: fromRaw.operations.length }]);
    });
  });

  test("missing Categories.json fails with the missing path", () => {
    const missing = "C:\\no\\such\\cyberchef\\Categories.json";
    assert.throws(() => readCategories(missing), new RegExp(missing.replace(/\\/g, "\\\\")));
  });

  test("search finds From Base64, an AES operation, and unavailable Fork", () => {
    const base64 = searchOperations("From Base64");
    assert.ok(base64.some((hit) => hit.name === "From Base64" && hit.available && hit.description.length > 0));

    const aes = searchOperations("AES");
    assert.ok(aes.some((hit) => hit.name.toLowerCase().includes("aes") && hit.category.length > 0));

    const fork = searchOperations("Fork").find((hit) => hit.name === "Fork");
    assert.ok(fork);
    assert.equal(fork.available, false);
    assert.match(fork.unavailableReason ?? "", /ExcludedOperationError/);
    assert.equal(fork.category.length > 0, true);
  });

  test("describe_operation on AES includes its arguments", async () => {
    const described = await describeOperation("AES");
    assert.match(described.name, /AES/);
    assert.equal(typeof described.description, "string");
    assert.ok(described.description.length > 0);
    assert.equal(typeof described.inputType, "string");
    assert.equal(typeof described.outputType, "string");
    assert.ok(Array.isArray(described.args));
    assert.ok(described.args.length > 0);
    assert.ok(described.args.some((arg) => {
      return Boolean(arg && typeof arg === "object" && "name" in arg && typeof arg.name === "string");
    }));
  });

  test("an unknown argument type still produces a string field", () => {
    const field = chefArgToZod({ name: "Thing", type: "widget", value: { example: true } });
    assert.match(field.description ?? "", /CyberChef type: widget/);
    assert.match(field.description ?? "", /Default:/);
    const parsed = readFileSync(categoriesFilePath(), "utf8");
    assert.ok(parsed.includes("Data format"));
  });
});
