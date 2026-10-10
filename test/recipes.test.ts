import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChefInputError } from "../src/errors.ts";
import { shutdownWorkers } from "../src/execute.ts";
import { deleteRecipe, listRecipes, loadRecipe, saveRecipe } from "../src/recipes.ts";
import { ALWAYS_ON_TOOLS } from "../src/registry.ts";
import { createChefServer } from "../src/server.ts";

const recipe = [
  { op: "From Hex", args: ["Auto"] },
  { op: "From Base64", args: ["A-Za-z0-9+/=", true, false] },
];

before(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "cyberchef-recipes-"));
  process.env.CYBERCHEF_RECIPE_PATH = path.join(dir, "recipes.json");
});

beforeEach(() => {
  rmSync(process.env.CYBERCHEF_RECIPE_PATH ?? "", { force: true });
});

after(async () => {
  await shutdownWorkers();
});

describe("recipe store", { concurrency: 1 }, () => {
  test("save then load returns the same steps", () => {
    const saved = saveRecipe("hex then base64", recipe);
    assert.equal(saved.name, "hex then base64");
    assert.equal(saved.steps, 2);
    const loaded = loadRecipe("HEX THEN BASE64");
    assert.equal(loaded.name, "hex then base64");
    assert.deepEqual(loaded.recipe, recipe);
  });

  test("saving the same name replaces the stored steps", () => {
    saveRecipe("hex then base64", recipe);
    saveRecipe("hex then base64", [{ op: "To Hex" }]);
    assert.deepEqual(loadRecipe("hex then base64").recipe, [{ op: "To Hex" }]);
  });

  test("list and delete round-trip", () => {
    saveRecipe("hex then base64", recipe);
    assert.deepEqual(listRecipes(), [{ name: "hex then base64", steps: 2 }]);
    assert.deepEqual(deleteRecipe("hex then base64"), { name: "hex then base64" });
    assert.deepEqual(listRecipes(), []);
    assert.throws(() => loadRecipe("hex then base64"), ChefInputError);
  });

  test("a recipe step needs an operation name", () => {
    assert.throws(() => saveRecipe("empty", []), ChefInputError);
    assert.throws(() => saveRecipe("bad", [{ op: "  " }]), ChefInputError);
  });
});

describe("recipe tools", { concurrency: 1 }, () => {
  test("save_recipe then load_recipe bakes the stored steps", { timeout: 180_000 }, async () => {
    const server = createChefServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cyberchef-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      for (const name of ["save_recipe", "load_recipe", "list_recipes", "delete_recipe"]) {
        assert.ok(listed.tools.some((tool) => tool.name === name), name);
      }
      for (const name of ALWAYS_ON_TOOLS) {
        assert.ok(listed.tools.some((tool) => tool.name === name), name);
      }

      const saved = await callJson(client, "save_recipe", { name: "sample", recipe });
      assert.equal(saved.name, "sample");
      const loaded = await callJson(client, "load_recipe", { name: "sample" });
      assert.deepEqual(loaded.recipe, recipe);
      const baked = await callJson(client, "bake", {
        input: "64 47 56 7a 64 41 3d 3d",
        recipe: loaded.recipe,
      });
      assert.equal(baked.output, "test");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<{
  name?: string;
  recipe?: unknown;
  output?: string;
}> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? "";
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text) as { name?: string; recipe?: unknown; output?: string };
}
