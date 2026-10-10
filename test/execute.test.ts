import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { searchOperations } from "../src/catalog.ts";
import { ChefTimeoutError } from "../src/errors.ts";
import { bake, lastWorkerExit, magic, runOperation, shutdownWorkers, workerThreadId } from "../src/execute.ts";
import { createChefServer } from "../src/server.ts";

after(async () => {
  await shutdownWorkers();
});

const INPUT = "64 47 56 7a 64 41 3d 3d";

describe("execute", { concurrency: 1 }, () => {
  test("From Hex (Auto) then From Base64 yields test", { timeout: 180_000 }, async () => {
    const baked = await bake(INPUT, [
      { op: "From Hex", args: ["Auto"] },
      { op: "From Base64", args: ["A-Za-z0-9+/=", true, false] },
    ]);
    assert.equal(baked.encoding, "utf8");
    assert.equal(baked.output, "test");

    const asBase64 = await runOperation("From Hex", INPUT, "utf8", ["Auto"]);
    assert.equal(asBase64.encoding, "utf8");
    assert.equal(asBase64.output, "dGVzdA==");
    const decoded = await runOperation("From Base64", asBase64.output, "utf8", ["A-Za-z0-9+/=", true, false]);
    assert.equal(decoded.output, "test");
    assert.equal(decoded.encoding, "utf8");
  });

  test("gzip output is base64 and does not throw", { timeout: 180_000 }, async () => {
    const result = await runOperation("Gzip", "test");
    assert.equal(result.encoding, "base64");
    const bytes = Buffer.from(result.output, "base64");
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
  });

  test("magic returns a utf-8 result", { timeout: 180_000 }, async () => {
    const result = await magic("aGk=", { depth: 1, intensive: false, languageSupport: false, crib: "" });
    assert.equal(result.encoding, "utf8");
    assert.equal(typeof result.output, "string");
    assert.ok(result.output.length > 0);
    JSON.parse(result.output);
  });

  test("network switch keeps Networking searchable and blocks run_operation", { timeout: 60_000 }, async () => {
    const previous = process.env.CYBERCHEF_ALLOW_NETWORK;
    const server = createChefServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cyberchef-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      process.env.CYBERCHEF_ALLOW_NETWORK = "true";
      const allowed = searchOperations("HTTP request", "Networking").find((hit) => hit.name === "HTTP request");
      assert.ok(allowed);
      assert.equal(allowed.available, true);

      process.env.CYBERCHEF_ALLOW_NETWORK = "false";
      const blocked = searchOperations("HTTP request", "Networking").find((hit) => hit.name === "HTTP request");
      assert.ok(blocked);
      assert.equal(blocked.available, false);
      assert.match(blocked.unavailableReason ?? "", /CYBERCHEF_ALLOW_NETWORK/);
      const fork = searchOperations("Fork").find((hit) => hit.name === "Fork");
      assert.equal(fork?.available, false);

      const result = await client.callTool({
        name: "run_operation",
        arguments: { name: "HTTP request", input: "https://example.com" },
      });
      assert.equal(result.isError, true);
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      assert.match(text, /CYBERCHEF_ALLOW_NETWORK/);
      assert.doesNotMatch(text, /ECONN|ENOTFOUND|fetch/i);
    } finally {
      if (previous === undefined) delete process.env.CYBERCHEF_ALLOW_NETWORK;
      else process.env.CYBERCHEF_ALLOW_NETWORK = previous;
      await client.close();
      await server.close();
    }
  });

  test("a timeout terminates the worker", { timeout: 180_000 }, async () => {
    await runOperation("To Hex", "A");
    const threadId = workerThreadId();
    assert.equal(typeof threadId, "number");
    const started = Date.now();
    await assert.rejects(
      () => runOperation("Sleep", "hi", "utf8", [30_000], { timeoutMs: 400 }),
      (error: unknown) => {
        assert.ok(error instanceof ChefTimeoutError);
        assert.equal(error.workerTerminated, true);
        assert.match(error.message, /terminated/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 15_000);
    const exit = lastWorkerExit();
    assert.equal(exit?.threadId, threadId);
    assert.notEqual(exit?.code, 0);
    assert.equal(workerThreadId(), null);

    const again = await runOperation("To Hex", "A");
    assert.match(again.output, /41/);
  });
});
