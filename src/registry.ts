import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  describeOperation,
  findOperation,
  requireCategory,
  requireOperation,
  toolNameFor,
} from "./catalog.ts";
import { runOperation } from "./execute.ts";
import { runAcrossInput } from "./files.ts";
import { ChefInputError } from "./errors.ts";
import { operationInputShape } from "./schema.ts";

export const ALWAYS_ON_TOOLS = [
  "list_categories",
  "search_operations",
  "describe_operation",
  "run_operation",
  "bake",
  "magic",
  "enable_category",
  "disable_category",
  "enable_operations",
  "disable_operations",
  "save_recipe",
  "load_recipe",
  "list_recipes",
  "delete_recipe",
] as const;

const ALWAYS_ON = new Set<string>(ALWAYS_ON_TOOLS);

export function isAlwaysOnTool(name: string): boolean {
  return ALWAYS_ON.has(name);
}

type MountedTool = {
  toolName: string;
  registration: RegisteredTool;
  reasons: Set<string>;
};

function categoryReason(category: string): string {
  return `category:${category.toLowerCase()}`;
}

function operationReason(name: string): string {
  return `operation:${name.toLowerCase()}`;
}

function shorten(value: string): string {
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

export function createToolRegistry(server: McpServer) {
  const mounted = new Map<string, MountedTool>();

  function refuseAlwaysOn(toolName: string) {
    if (ALWAYS_ON.has(toolName)) {
      throw new Error(`Refusing to remove always-on tool ${toolName}.`);
    }
  }

  async function mount(operationName: string, reason: string): Promise<string> {
    const operation = requireOperation(operationName);
    const existing = mounted.get(operation.name);
    if (existing) {
      existing.reasons.add(reason);
      return existing.toolName;
    }
    const described = await describeOperation(operation.name);
    const toolName = toolNameFor(operation.name);
    refuseAlwaysOn(toolName);
    const availability = described.available
      ? ""
      : ` Unavailable: ${described.unavailableReason ?? "this operation cannot be run."}`;
    const registration = server.registerTool(
      toolName,
      {
        title: operation.name,
        description: `${operation.name} (${operation.category}). ${shorten(described.description)}${availability}`,
        inputSchema: operationInputShape(described.args),
        annotations: {
          title: operation.name,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: operation.category.toLowerCase() === "networking",
        },
      },
      async (args: {
        input?: string;
        inputEncoding?: unknown;
        inputPath?: string;
        outputPath?: string;
      }) => {
        try {
          const { input, inputEncoding, inputPath, outputPath, ...operationArgs } = args;
          const result = await runAcrossInput({
            input,
            inputEncoding,
            inputPath,
            outputPath,
            run: (data, encoding) => runOperation(operation.name, data, encoding, operationArgs),
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true as const, content: [{ type: "text" as const, text: message }] };
        }
      },
    );
    mounted.set(operation.name, { toolName, registration, reasons: new Set([reason]) });
    return toolName;
  }

  function unmount(operationName: string, reason: string): string | undefined {
    const operation = findOperation(operationName);
    if (!operation) {
      throw new ChefInputError(`Unknown operation "${operationName}". Use search_operations to find a name.`);
    }
    const existing = mounted.get(operation.name);
    if (!existing) return undefined;
    existing.reasons.delete(reason);
    if (existing.reasons.size > 0) return undefined;
    refuseAlwaysOn(existing.toolName);
    existing.registration.remove();
    mounted.delete(operation.name);
    return existing.toolName;
  }

  return {
    async enableCategory(category: string): Promise<string[]> {
      const record = requireCategory(category);
      const names: string[] = [];
      for (const operation of record.operations) {
        names.push(await mount(operation.name, categoryReason(record.name)));
      }
      return names;
    },
    async disableCategory(category: string): Promise<string[]> {
      const record = requireCategory(category);
      const removed: string[] = [];
      for (const operation of record.operations) {
        const toolName = unmount(operation.name, categoryReason(record.name));
        if (toolName) removed.push(toolName);
      }
      return removed;
    },
    async enableOperations(names: string[]): Promise<string[]> {
      if (!Array.isArray(names) || names.length === 0) {
        throw new ChefInputError("enable_operations requires at least one operation name.");
      }
      const mountedNames: string[] = [];
      for (const name of names) {
        const operation = requireOperation(name);
        mountedNames.push(await mount(operation.name, operationReason(operation.name)));
      }
      return mountedNames;
    },
    async disableOperations(names: string[]): Promise<string[]> {
      if (!Array.isArray(names) || names.length === 0) {
        throw new ChefInputError("disable_operations requires at least one operation name.");
      }
      const removed: string[] = [];
      for (const name of names) {
        const operation = requireOperation(name);
        const toolName = unmount(operation.name, operationReason(operation.name));
        if (toolName) removed.push(toolName);
      }
      return removed;
    },
    mountedToolNames(): string[] {
      return [...mounted.values()].map((entry) => entry.toolName);
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
