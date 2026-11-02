import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChefInputError, ChefTimeoutError } from "../src/errors.ts";
import { shutdownWorkers } from "../src/execute.ts";
import type { EncodedOutput, InputEncoding, RecipeStep } from "../src/protocol.ts";
import { createChefServer } from "../src/server.ts";
import {
  buildAttempts,
  outputMatchesCrib,
  rankCandidates,
  runLadder,
  specialist,
  type Collected,
  type LadderRunners,
  type MagicSettings,
} from "../src/specialist.ts";

const settings: MagicSettings = {
  depth: 3,
  intensive: false,
  languageSupport: false,
  crib: "",
};

function text(output: string, encoding: EncodedOutput["encoding"] = "utf8"): EncodedOutput {
  return { output, encoding, type: "string" };
}

function runners(overrides: Partial<LadderRunners> = {}): LadderRunners {
  return {
    bake: async () => text("baked"),
    magic: async () => text("magic"),
    ...overrides,
  };
}

describe("specialist ladder", { concurrency: 1 }, () => {
  test("a prefix stays on every attempt and bare Magic is absent", () => {
    const attempts = buildAttempts([{ op: "From Base64" }], { ...settings, crib: "flag{" });
    assert.equal(attempts.length, 11);
    assert.ok(attempts.every((attempt) => attempt.recipe[0]?.op === "From Base64"));
    assert.ok(attempts.every((attempt) => attempt.recipe.filter((step) => step.op === "From Base64").length === 1));
    assert.equal(attempts[0]?.kind, "bake-then-magic");
    assert.deepEqual(attempts[0]?.recipe.map((step) => step.op), ["From Base64", "Magic"]);
    assert.deepEqual(attempts[0]?.recipe[1]?.args, [3, false, false, "flag{"]);
    const brutes = attempts.filter((attempt) => attempt.kind === "brute");
    assert.deepEqual(brutes.map((attempt) => attempt.recipe.at(-1)?.op), ["XOR Brute Force", "ROT13 Brute Force"]);
    assert.ok(brutes.every((attempt) => attempt.recipe.every((step) => step.op !== "Magic")));
    assert.deepEqual(brutes[0]?.step.args, { "Crib (known plaintext string)": "flag{" });
  });

  test("no prefix starts with Magic and keeps every undo step", () => {
    const attempts = buildAttempts([], settings);
    assert.equal(attempts.length, 12);
    assert.equal(attempts[0]?.kind, "magic");
    assert.deepEqual(attempts[0]?.recipe.map((step) => step.op), ["Magic"]);
    assert.equal(attempts.filter((attempt) => attempt.kind === "magic").length, 1);
    assert.ok(attempts.some((attempt) => attempt.recipe.some((step) => step.op === "From Base64")));
  });

  test("a crib match stops before later attempts", async () => {
    let magicCalls = 0;
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      crib: "flag{",
      maxAttempts: 4,
    }, runners({
      magic: async () => {
        magicCalls += 1;
        return text("flag{hi}");
      },
    }));
    assert.equal(magicCalls, 1);
    assert.equal(result.hit, true);
    assert.equal(result.reason, "crib");
    assert.equal(result.output, "flag{hi}");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.matchedCrib, true);
  });

  test("a throwing decoder is skipped and the next attempt still runs", async () => {
    const baked: string[] = [];
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      maxAttempts: 3,
    }, runners({
      bake: async (_input, recipe) => {
        const op = recipe[0]?.op ?? "";
        baked.push(op);
        if (op === "From Base64") throw new Error("bad decoder");
        return text("decoded");
      },
      magic: async (input) => text(input === "decoded" ? "plain" : "still"),
    }));
    assert.deepEqual(baked, ["From Base64", "From Base32"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.output), ["still", "plain"]);
    assert.equal(result.hit, false);
    assert.equal(result.reason, "local");
  });

  test("a failed prefix fails the call", async () => {
    let magicCalls = 0;
    await assert.rejects(
      () => runLadder({
        input: "blob",
        inputEncoding: "utf8",
        prefix: [{ op: "From Base64" }],
      }, runners({
        bake: async () => {
          throw new Error("bad prefix");
        },
        magic: async () => {
          magicCalls += 1;
          return text("nope");
        },
      })),
      /bad prefix/,
    );
    assert.equal(magicCalls, 0);
  });

  test("an unknown prefix operation fails before any attempt", async () => {
    await assert.rejects(
      () => runLadder({
        input: "blob",
        inputEncoding: "utf8",
        prefix: [{ op: "Not A Real Operation" }],
      }, runners()),
      ChefInputError,
    );
  });

  test("each stage receives the previous stage's encoding", async () => {
    const bakeEncodings: InputEncoding[] = [];
    const magicEncodings: InputEncoding[] = [];
    const bakeOps: string[] = [];
    await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      prefix: [{ op: "From Base64" }],
      maxAttempts: 2,
    }, runners({
      bake: async (_input, recipe, encoding) => {
        bakeEncodings.push(encoding);
        bakeOps.push(recipe.map((step) => step.op).join(","));
        if (recipe.length === 1 && recipe[0]?.op === "From Base64") return text("AAA", "base64");
        return text("text");
      },
      magic: async (_input, options) => {
        magicEncodings.push(options.inputEncoding);
        return text("out");
      },
    }));
    assert.deepEqual(bakeOps, ["From Base64", "From Base32"]);
    assert.deepEqual(bakeEncodings, ["utf8", "base64"]);
    assert.deepEqual(magicEncodings, ["base64", "utf8"]);
  });

  test("a timeout stops the ladder and keeps earlier candidates", async () => {
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      maxAttempts: 3,
    }, runners({
      magic: async (input) => {
        if (input === "next") throw new ChefTimeoutError(1);
        return text("first");
      },
      bake: async () => text("next"),
    }));
    assert.deepEqual(result.candidates.map((candidate) => candidate.output), ["first"]);
    assert.equal(result.reason, "local");
  });

  test("a regular-expression crib matches when the literal text does not", async () => {
    assert.equal(await outputMatchesCrib("flag{hi}", "flag\\{[a-z]+\\}"), true);
    assert.equal(await outputMatchesCrib("nope", "flag{"), false);
    assert.equal(await outputMatchesCrib("flag{hi}", ""), false);
  });

  test("a backtracking crib regex is capped and misses", async () => {
    const start = Date.now();
    assert.equal(await outputMatchesCrib("a".repeat(200), "(a+)+b"), false);
    assert.ok(Date.now() - start < 5_000);
  });

  test("a crib match outranks a later UTF-8 result", async () => {
    const items: Collected[] = [
      { recipe: [{ op: "Magic" }], output: "hello", encoding: "utf8", type: "string", matchedCrib: false, order: 0 },
      { recipe: [{ op: "From Hex" }, { op: "Magic" }], output: "flag{a}", encoding: "utf8", type: "string", matchedCrib: true, order: 1 },
    ];
    const ranked = await rankCandidates(items, { input: "blob" });
    assert.equal(ranked.reason, "crib");
    assert.equal(ranked.ordered[0]?.output, "flag{a}");
    assert.equal(ranked.ordered[1]?.output, "hello");
  });

  test("UTF-8 that changed ranks ahead of base64", async () => {
    const items: Collected[] = [
      { recipe: [{ op: "Magic" }], output: "aaaa", encoding: "base64", type: "raw", matchedCrib: false, order: 0 },
      { recipe: [{ op: "From Hex" }, { op: "Magic" }], output: "hello", encoding: "utf8", type: "string", matchedCrib: false, order: 1 },
    ];
    const ranked = await rankCandidates(items, { input: "blob" });
    assert.equal(ranked.reason, "local");
    assert.equal(ranked.ordered[0]?.output, "hello");
    assert.equal(ranked.ordered[1]?.output, "aaaa");
  });

  test("an empty prefix starts with Magic", async () => {
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      prefix: [],
      maxAttempts: 1,
    }, runners());
    assert.deepEqual(result.recipe.map((step) => step.op), ["Magic"]);
    assert.equal(result.candidates.length, 1);
  });

  test("a blank prefix step and a non-positive budget are rejected", async () => {
    await assert.rejects(
      () => runLadder({ input: "blob", inputEncoding: "utf8", prefix: [{ op: "  " }] }, runners()),
      ChefInputError,
    );
    await assert.rejects(
      () => runLadder({ input: "blob", inputEncoding: "utf8", maxAttempts: 0 }, runners()),
      ChefInputError,
    );
    await assert.rejects(
      () => runLadder({ input: "blob", inputEncoding: "utf8", depth: -1 }, runners()),
      ChefInputError,
    );
  });

  test("maxAttempts stops after the prefixed Magic call", async () => {
    let bakes = 0;
    let magics = 0;
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      prefix: [{ op: "From Base64" }],
      maxAttempts: 1,
    }, runners({
      bake: async () => {
        bakes += 1;
        return text("decoded");
      },
      magic: async () => {
        magics += 1;
        return text("once");
      },
    }));
    assert.equal(bakes, 1);
    assert.equal(magics, 1);
    assert.deepEqual(result.recipe.map((step) => step.op), ["From Base64", "Magic"]);
    assert.equal(result.candidates.length, 1);
  });

  test("a lowercase prefix name is canonicalised", async () => {
    let baked = "";
    await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      prefix: [{ op: "from base64" }],
      maxAttempts: 1,
    }, runners({
      bake: async (_input, recipe) => {
        baked = recipe.map((step) => step.op).join(",");
        return text("decoded");
      },
    }));
    assert.equal(baked, "From Base64");
  });

  test("every failed attempt returns an empty result", async () => {
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      maxAttempts: 3,
    }, runners({
      magic: async () => {
        throw new Error("no magic");
      },
      bake: async () => {
        throw new Error("no bake");
      },
    }));
    assert.equal(result.hit, false);
    assert.equal(result.reason, "local");
    assert.equal(result.output, "");
    assert.deepEqual(result.candidates, []);
  });

  test("a later crib match stops the ladder and becomes the winner", async () => {
    let magicCalls = 0;
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      crib: "flag{",
      maxAttempts: 5,
    }, runners({
      bake: async () => text("step"),
      magic: async () => {
        magicCalls += 1;
        return text(magicCalls === 2 ? "flag{ok}" : "no");
      },
    }));
    assert.equal(magicCalls, 2);
    assert.equal(result.hit, true);
    assert.equal(result.output, "flag{ok}");
    assert.equal(result.candidates[0]?.matchedCrib, true);
    assert.equal(result.candidates.length, 2);
  });

  test("the clock budget keeps the first candidate and skips the rest", async () => {
    let clock = 0;
    const calls: string[] = [];
    const result = await runLadder({
      input: "blob",
      inputEncoding: "utf8",
      timeoutMs: 10,
      now: () => clock,
      maxAttempts: 4,
    }, runners({
      magic: async () => {
        calls.push("magic");
        clock = 100;
        return text("kept");
      },
      bake: async () => {
        calls.push("bake");
        return text("later");
      },
    }));
    assert.deepEqual(calls, ["magic"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.output), ["kept"]);
  });

  test("unchanged text ranks below text that changed", async () => {
    const items: Collected[] = [
      { recipe: [{ op: "Magic" }], output: "blob", encoding: "utf8", type: "string", matchedCrib: false, order: 0 },
      { recipe: [{ op: "From Hex" }, { op: "Magic" }], output: "other", encoding: "utf8", type: "string", matchedCrib: false, order: 1 },
    ];
    const ranked = await rankCandidates(items, { input: "blob" });
    assert.equal(ranked.ordered[0]?.output, "other");
  });

  test("whitespace is not a crib", async () => {
    assert.equal(await outputMatchesCrib("flag{hi}", "   "), false);
  });

  test("specialist with one attempt runs Magic on a Base64 sample", { timeout: 180_000 }, async () => {
    const server = createChefServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cyberchef-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "specialist"));
      const result = await client.callTool({
        name: "specialist",
        arguments: { input: "aGk=", maxAttempts: 1, depth: 1 },
      });
      const textBody = (result.content as { text?: string }[])[0]?.text ?? "";
      assert.notEqual(result.isError, true, textBody);
      const parsed = JSON.parse(textBody) as {
        output: string;
        hit: boolean;
        reason: string;
        recipe: RecipeStep[];
        candidates: { recipe: RecipeStep[] }[];
      };
      assert.equal(parsed.hit, false);
      assert.equal(parsed.reason, "local");
      assert.equal(parsed.candidates.length, 1);
      assert.deepEqual(parsed.recipe.map((step) => step.op), ["Magic"]);
      assert.ok(parsed.output.length > 0);
      JSON.parse(parsed.output);

      const rejected = await client.callTool({
        name: "specialist",
        arguments: { input: "a", inputPath: "b" },
      });
      assert.equal(rejected.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a Base64 prefix hits the crib without trying later decoders", { timeout: 180_000 }, async () => {
    const result = await specialist("dGVzdA==", {
      prefix: [{ op: "from base64" }],
      maxAttempts: 1,
      depth: 0,
      crib: "test",
    });
    assert.equal(result.hit, true);
    assert.equal(result.reason, "crib");
    assert.deepEqual(result.recipe.map((step) => step.op), ["From Base64", "Magic"]);
    assert.equal(result.candidates.length, 1);
    assert.match(result.output, /"data": "test"/);
  });

  test("Magic misses Base64 and the next decoder hits the crib", { timeout: 180_000 }, async () => {
    const result = await specialist("aGk=", {
      maxAttempts: 2,
      depth: 0,
      crib: "hi",
    });
    assert.equal(result.hit, true);
    assert.deepEqual(result.recipe.map((step) => step.op), ["From Base64", "Magic"]);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0]?.matchedCrib, true);
    assert.deepEqual(result.candidates[1]?.recipe.map((step) => step.op), ["Magic"]);
    assert.equal(result.candidates[1]?.matchedCrib, false);
  });

  test("Base64 then Magic misses hex, and Base64 then From Hex hits it", { timeout: 180_000 }, async () => {
    const result = await specialist("Njg2OQ==", {
      prefix: [{ op: "From Base64" }],
      maxAttempts: 4,
      depth: 0,
      crib: "hi",
    });
    assert.equal(result.hit, true);
    assert.equal(result.reason, "crib");
    assert.deepEqual(result.recipe.map((step) => step.op), ["From Base64", "From Hex", "Magic"]);
    assert.equal(result.candidates.length, 4);
    assert.equal(result.candidates[0]?.matchedCrib, true);
    assert.ok(result.candidates.slice(1).every((candidate) => candidate.matchedCrib === false));
    assert.match(result.output, /"data": "hi"/);
  });
});

after(async () => {
  await shutdownWorkers();
});
