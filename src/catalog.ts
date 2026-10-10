import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ChefInputError } from "./errors.ts";

const NODE_API_EXCLUSION =
  "Excluded from the CyberChef Node API (ExcludedOperationError).";

const NETWORK_DISABLED =
  "Networking operations are disabled because CYBERCHEF_ALLOW_NETWORK=false.";

/** Class-name list shipped with CyberChef. Used only if that file cannot be read. */
const FALLBACK_EXCLUSIONS = [
  "Fork",
  "Merge",
  "Jump",
  "ConditionalJump",
  "Label",
  "Comment",
  "JavaScriptBeautify",
  "JavaScriptMinify",
  "JavaScriptParser",
  "SyntaxHighlighter",
];

export type OperationHit = {
  name: string;
  category: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
};

export type CategorySummary = {
  name: string;
  operationCount: number;
};

type OperationRecord = {
  name: string;
  category: string;
};

type CategoryRecord = {
  name: string;
  operations: OperationRecord[];
};

type Catalog = {
  filePath: string;
  categories: CategoryRecord[];
  operations: OperationRecord[];
  excluded: Set<string>;
  toolNames: Map<string, string>;
};

let catalog: Catalog | null = null;
let descriptions: Map<string, string> | null = null;

export function sanitiseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function networkAllowed(): boolean {
  return process.env.CYBERCHEF_ALLOW_NETWORK?.toLowerCase() !== "false";
}

export function cyberchefRoot(): string {
  const entry = createRequire(import.meta.url).resolve("cyberchef");
  let dir = path.dirname(entry);
  while (true) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "cyberchef") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the installed cyberchef package from ${entry}`);
    }
    dir = parent;
  }
}

export function categoriesFilePath(): string {
  return path.join(cyberchefRoot(), "src", "core", "config", "Categories.json");
}

function operationName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as { name?: unknown; op?: unknown };
  if (typeof record.name === "string") return record.name;
  if (typeof record.op === "string") return record.op;
  return undefined;
}

export function readCategories(filePath: string): { name: string; operations: string[] }[] {
  if (!existsSync(filePath)) {
    throw new Error(`CyberChef categories file not found: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CyberChef categories file could not be parsed: ${filePath} (${message})`);
  }

  const parsed: { name: string; operations: string[] }[] = [];
  const push = (name: string, ops: unknown) => {
    const operations = Array.isArray(ops)
      ? ops.map(operationName).filter((name): name is string => Boolean(name))
      : [];
    parsed.push({ name, operations });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const category = item as { name?: unknown; ops?: unknown };
      if (typeof category.name === "string") push(category.name, category.ops);
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, ops] of Object.entries(raw as Record<string, unknown>)) push(name, ops);
  }

  if (parsed.length === 0) {
    throw new Error(`CyberChef categories file did not contain any categories: ${filePath}`);
  }
  return parsed;
}

function loadExclusions(root: string): Set<string> {
  const filePath = path.join(root, "src", "node", "config", "excludedOperations.mjs");
  let names = FALLBACK_EXCLUSIONS;
  if (existsSync(filePath)) {
    const source = readFileSync(filePath, "utf8");
    const found = [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
    if (found.length > 0) names = found;
  }
  return new Set(names.map(sanitiseName));
}

function slug(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `cc_${cleaned || "operation"}`;
}

export function loadCatalog(): Catalog {
  if (catalog) return catalog;
  const filePath = categoriesFilePath();
  const categories = readCategories(filePath).map((category) => ({
    name: category.name,
    operations: category.operations.map((name) => ({ name, category: category.name })),
  }));
  const operations = categories.flatMap((category) => category.operations);
  const toolNames = new Map<string, string>();
  const used = new Set<string>();
  for (const operation of operations) {
    if (toolNames.has(operation.name)) continue;
    let toolName = slug(operation.name);
    let suffix = 2;
    while (used.has(toolName)) {
      toolName = `${slug(operation.name)}_${suffix}`;
      suffix += 1;
    }
    used.add(toolName);
    toolNames.set(operation.name, toolName);
  }
  catalog = {
    filePath,
    categories,
    operations,
    excluded: loadExclusions(cyberchefRoot()),
    toolNames,
  };
  return catalog;
}

export function toolNameFor(operationName: string): string {
  const operation = findOperation(operationName);
  if (!operation) {
    throw new ChefInputError(`Unknown operation "${operationName}". Use search_operations to find a name.`);
  }
  const toolName = loadCatalog().toolNames.get(operation.name);
  if (!toolName) {
    throw new ChefInputError(`No tool name for operation "${operation.name}".`);
  }
  return toolName;
}

function shorten(value: string | undefined): string {
  if (!value) return "";
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|div|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function descriptionFor(name: string): string {
  if (!descriptions) {
    descriptions = new Map();
    const filePath = path.join(cyberchefRoot(), "src", "core", "config", "OperationConfig.json");
    if (existsSync(filePath)) {
      const config = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, { description?: string }>;
      for (const [operationName, value] of Object.entries(config)) {
        descriptions.set(operationName, shorten(value?.description));
      }
    }
  }
  return descriptions.get(name) ?? "";
}

export function isNetworkingCategory(name: string): boolean {
  return name.toLowerCase() === "networking";
}

export function availabilityFor(operation: OperationRecord): { available: boolean; unavailableReason?: string } {
  if (loadCatalog().excluded.has(sanitiseName(operation.name))) {
    return { available: false, unavailableReason: NODE_API_EXCLUSION };
  }
  if (isNetworkingCategory(operation.category) && !networkAllowed()) {
    return { available: false, unavailableReason: NETWORK_DISABLED };
  }
  return { available: true };
}

function toHit(operation: OperationRecord): OperationHit {
  const availability = availabilityFor(operation);
  return {
    name: operation.name,
    category: operation.category,
    description: descriptionFor(operation.name),
    available: availability.available,
    ...(availability.unavailableReason ? { unavailableReason: availability.unavailableReason } : {}),
  };
}

export function listCategories(name?: string): CategorySummary[] {
  const summaries = loadCatalog().categories.map((category) => ({
    name: category.name,
    operationCount: category.operations.length,
  }));
  if (!name?.trim()) return summaries;
  const needle = name.trim().toLowerCase();
  return summaries.filter((category) => category.name.toLowerCase() === needle);
}

export function findCategory(name: string): CategoryRecord | undefined {
  const needle = name.trim().toLowerCase();
  return loadCatalog().categories.find((category) => category.name.toLowerCase() === needle);
}

export function findOperation(name: string): OperationRecord | undefined {
  const needle = name.trim().toLowerCase();
  const sanitised = sanitiseName(name);
  const operations = loadCatalog().operations;
  return (
    operations.find((operation) => operation.name.toLowerCase() === needle) ??
    operations.find((operation) => sanitiseName(operation.name) === sanitised)
  );
}

export function requireOperation(name: string): OperationRecord {
  const operation = findOperation(name);
  if (!operation) {
    throw new ChefInputError(`Unknown operation "${name}". Use search_operations to find a name.`);
  }
  return operation;
}

export function requireCategory(name: string): CategoryRecord {
  const category = findCategory(name);
  if (!category) {
    throw new ChefInputError(`Unknown category "${name}". Use list_categories.`);
  }
  return category;
}

export function assertRunnable(name: string): OperationRecord {
  const operation = requireOperation(name);
  const availability = availabilityFor(operation);
  if (!availability.available) {
    throw new ChefInputError(
      `${operation.name} is not available. ${availability.unavailableReason ?? "The Node API cannot run this operation."}`,
    );
  }
  return operation;
}

export function searchOperations(query?: string, category?: string): OperationHit[] {
  const needle = query?.trim().toLowerCase() ?? "";
  const categoryNeedle = category?.trim().toLowerCase();
  return loadCatalog()
    .operations.filter((operation) => {
      if (categoryNeedle && operation.category.toLowerCase() !== categoryNeedle) return false;
      if (!needle) return true;
      const description = descriptionFor(operation.name).toLowerCase();
      return operation.name.toLowerCase().includes(needle) || description.includes(needle);
    })
    .map(toHit);
}

type HelpRecord = {
  name?: string;
  description?: string;
  inputType?: string;
  outputType?: string;
  args?: unknown[];
};

type ChefModule = {
  help: (input: string) => HelpRecord[] | null;
};

let chefModule: Promise<ChefModule> | null = null;

export function loadChef(): Promise<ChefModule> {
  if (!chefModule) {
    chefModule = (async () => {
      try {
        const log = await import("loglevel");
        log.default.setLevel("silent");
      } catch {
        // Best-effort. CyberChef still runs if loglevel is not hoisted.
      }
      const imported = await import("cyberchef");
      return imported.default as ChefModule;
    })();
  }
  return chefModule;
}

export type OperationDescription = {
  name: string;
  description: string;
  inputType: string;
  outputType: string;
  args: unknown[];
  available: boolean;
  unavailableReason?: string;
};

export async function describeOperation(name: string): Promise<OperationDescription> {
  const query = name.trim();
  const exact = findOperation(query);
  const operation =
    exact ??
    searchOperations(query)
      .filter((hit) => hit.name.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => left.name.length - right.name.length || left.name.localeCompare(right.name))[0];
  if (!operation) {
    throw new ChefInputError(`Unknown operation "${name}". Use search_operations to find a name.`);
  }
  const target = requireOperation(operation.name);
  const chef = await loadChef();
  const matches = chef.help(target.name);
  const record = matches?.find((match) => match.name === target.name) ?? matches?.[0];
  if (!record) {
    throw new ChefInputError(`CyberChef help returned no record for "${target.name}".`);
  }
  const availability = availabilityFor(target);
  return {
    name: target.name,
    description: record.description ?? "",
    inputType: record.inputType ?? "",
    outputType: record.outputType ?? "",
    args: Array.isArray(record.args) ? record.args : [],
    available: availability.available,
    ...(availability.unavailableReason ? { unavailableReason: availability.unavailableReason } : {}),
  };
}
