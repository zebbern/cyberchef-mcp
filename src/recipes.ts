import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ChefInputError } from "./errors.ts";
import type { RecipeStep } from "./protocol.ts";

type RecipeStore = Record<string, RecipeStep[]>;

export function recipeFilePath(): string {
  const configured = process.env.CYBERCHEF_RECIPE_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homedir(), ".cyberchef", "recipes.json");
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[\\/\0]/.test(trimmed)) {
    throw new ChefInputError("Recipe name must be a non-empty name without path separators.");
  }
  return trimmed;
}

export function assertRecipe(recipe: unknown): RecipeStep[] {
  if (!Array.isArray(recipe) || recipe.length === 0) {
    throw new ChefInputError("Recipe must be a non-empty list of { op, args } steps.");
  }
  return recipe.map((step) => {
    if (!step || typeof step !== "object") {
      throw new ChefInputError("Each recipe step needs an operation name.");
    }
    const record = step as { op?: unknown; args?: unknown };
    if (typeof record.op !== "string" || record.op.trim().length === 0) {
      throw new ChefInputError("Each recipe step needs an operation name.");
    }
    const saved: RecipeStep = { op: record.op.trim() };
    if ("args" in record) saved.args = record.args;
    return saved;
  });
}

function readStore(): RecipeStore {
  const file = recipeFilePath();
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new ChefInputError(`Recipe file is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChefInputError(`Recipe file is not a name-to-steps object: ${file}`);
  }
  return parsed as RecipeStore;
}

function writeStore(store: RecipeStore): void {
  const file = recipeFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temporary, file);
}

function keyFor(store: RecipeStore, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(store).find((key) => key.toLowerCase() === wanted);
}

export function saveRecipe(name: string, recipe: unknown): { name: string; steps: number } {
  const savedName = assertName(name);
  const steps = assertRecipe(recipe);
  const store = readStore();
  const key = keyFor(store, savedName) ?? savedName;
  store[key] = steps;
  writeStore(store);
  return { name: key, steps: steps.length };
}

export function loadRecipe(name: string): { name: string; recipe: RecipeStep[] } {
  const savedName = assertName(name);
  const store = readStore();
  const key = keyFor(store, savedName);
  if (!key) throw new ChefInputError(`No saved recipe named ${savedName}.`);
  return { name: key, recipe: assertRecipe(store[key]) };
}

export function listRecipes(): { name: string; steps: number }[] {
  return Object.entries(readStore())
    .map(([name, recipe]) => ({ name, steps: Array.isArray(recipe) ? recipe.length : 0 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function deleteRecipe(name: string): { name: string } {
  const savedName = assertName(name);
  const store = readStore();
  const key = keyFor(store, savedName);
  if (!key) throw new ChefInputError(`No saved recipe named ${savedName}.`);
  delete store[key];
  writeStore(store);
  return { name: key };
}
