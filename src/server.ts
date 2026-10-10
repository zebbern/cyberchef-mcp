import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  describeOperation,
  listCategories,
  loadCatalog,
  searchOperations,
} from "./catalog.ts";
import { ChefInputError, ChefTimeoutError } from "./errors.ts";
import { bake, magic, runOperation } from "./execute.ts";
import { runAcrossInput } from "./files.ts";
import { deleteRecipe, listRecipes, loadRecipe, saveRecipe } from "./recipes.ts";
import { ALWAYS_ON_TOOLS, createToolRegistry } from "./registry.ts";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ChefInputError) && !(error instanceof ChefTimeoutError)) {
    console.error(error);
  }
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export function createChefServer(): McpServer {
  loadCatalog();
  const server = new McpServer(
    { name: "cyberchef", version: "1.0.0" },
    {
      instructions:
        "Search or describe a CyberChef operation, then run_operation or bake. Pass input as text, or inputPath as a file or folder. outputPath writes the raw bytes to disk. save_recipe stores a recipe on disk; load_recipe returns it for a later bake. enable_category and enable_operations add cc_<slug> tools for the rest of the session; disable removes only those tools. Networking stays available unless CYBERCHEF_ALLOW_NETWORK=false.",
    },
  );
  const registry = createToolRegistry(server);

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description: "List CyberChef categories and how many operations each one contains. An optional name is matched without case sensitivity, so Data Format matches Data format.",
      inputSchema: {
        name: z.string().optional().describe("Category name. Matching is case-insensitive. Omit to list every category."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => textResult({ categories: listCategories(name) }),
  );

  server.registerTool(
    "search_operations",
    {
      title: "Search operations",
      description: "Search the full CyberChef catalog, including Networking and operations the Node API cannot run. Each hit has name, category, description, and available.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match against the operation name and description. Omit to return the whole catalog."),
        category: z.string().optional().describe("Category filter. Matching is case-insensitive."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, category }) => textResult({ operations: searchOperations(query, category) }),
  );

  server.registerTool(
    "describe_operation",
    {
      title: "Describe operation",
      description: "Return the CyberChef help record for an operation: description, input type, output type, and arguments. Unavailable operations are still described.",
      inputSchema: {
        name: z.string().describe("Operation name. AES matches an AES operation; full names such as AES Encrypt are exact."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        return textResult(await describeOperation(name));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "run_operation",
    {
      title: "Run operation",
      description: "Run one CyberChef operation by name without mounting it. Pass input, or inputPath for a file or folder. outputPath writes the raw bytes. args is the positional list used by saved recipes, or a named object. Output is JSON { output, encoding, type }.",
      inputSchema: {
        name: z.string().describe("Operation name."),
        input: z.string().optional().describe("Data to process. Omit when inputPath is set."),
        inputEncoding: z.enum(["utf8", "base64", "hex"]).default("utf8").describe("How to decode input. Ignored when inputPath is set."),
        inputPath: z.string().optional().describe("File or folder to open as input. A folder runs the operation on each file, including nested files."),
        outputPath: z.string().optional().describe("File path for one input, or a folder when inputPath is a folder. The raw bytes are written there."),
        args: z.any().optional().describe("Positional argument list or named argument object. Omit to use defaults."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, input, inputEncoding, inputPath, outputPath, args }) => {
      try {
        return textResult(await runAcrossInput({
          input,
          inputEncoding,
          inputPath,
          outputPath,
          run: (data, encoding) => runOperation(name, data, encoding, args),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "bake",
    {
      title: "Bake recipe",
      description: "Run a CyberChef recipe, the same { op, args } list the Node API, the web app, and load_recipe accept. Pass input, or inputPath for a file or folder. outputPath writes the raw bytes.",
      inputSchema: {
        input: z.string().optional().describe("Data to process. Omit when inputPath is set."),
        inputEncoding: z.enum(["utf8", "base64", "hex"]).default("utf8").describe("How to decode input. Ignored when inputPath is set."),
        inputPath: z.string().optional().describe("File or folder to open as input. A folder bakes each file, including nested files."),
        outputPath: z.string().optional().describe("File path for one input, or a folder when inputPath is a folder. The raw bytes are written there."),
        recipe: z.array(z.object({
          op: z.string().describe("Operation name."),
          args: z.any().optional().describe("Positional argument list or named argument object."),
        })).describe("Recipe steps in order."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ input, inputEncoding, inputPath, outputPath, recipe }) => {
      try {
        return textResult(await runAcrossInput({
          input,
          inputEncoding,
          inputPath,
          outputPath,
          run: (data, encoding) => bake(data, recipe, encoding),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "magic",
    {
      title: "Magic",
      description: "Run CyberChef Magic on input or on each file in inputPath. depth, intensive mode, extensive language support, and an optional crib filter the speculative decode. outputPath writes the raw bytes. This uses a longer timeout than bake.",
      inputSchema: {
        input: z.string().optional().describe("Data to inspect. Omit when inputPath is set."),
        inputEncoding: z.enum(["utf8", "base64", "hex"]).default("utf8").describe("How to decode input. Ignored when inputPath is set."),
        inputPath: z.string().optional().describe("File or folder to open as input. A folder runs Magic on each file, including nested files."),
        outputPath: z.string().optional().describe("File path for one input, or a folder when inputPath is a folder. The raw bytes are written there."),
        depth: z.number().int().min(0).default(3).describe("How many decode steps Magic may chain."),
        intensive: z.boolean().default(false).describe("Intensive mode. Brute-forces more encodings and is much slower."),
        languageSupport: z.boolean().default(false).describe("Extensive language support."),
        crib: z.string().default("").describe("Known plaintext or regular expression used to filter results."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ input, inputEncoding, inputPath, outputPath, depth, intensive, languageSupport, crib }) => {
      try {
        return textResult(await runAcrossInput({
          input,
          inputEncoding,
          inputPath,
          outputPath,
          run: (data, encoding) => magic(data, {
            inputEncoding: encoding,
            depth,
            intensive,
            languageSupport,
            crib,
          }),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "enable_category",
    {
      title: "Enable category",
      description: "Mount every operation in a category as its own cc_<slug> tool for this session. The category name is matched without case sensitivity.",
      inputSchema: {
        category: z.string().describe("Category name, for example Data format or Encryption / Encoding."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      try {
        return textResult({ mounted: await registry.enableCategory(category) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "disable_category",
    {
      title: "Disable category",
      description: "Remove the cc_<slug> tools mounted for a category. Search, bake, magic, recipe save/load, and the enable/disable tools stay registered.",
      inputSchema: {
        category: z.string().describe("Category name. Matching is case-insensitive."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      try {
        return textResult({ removed: await registry.disableCategory(category) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "enable_operations",
    {
      title: "Enable operations",
      description: "Mount only the named operations as cc_<slug> tools. Use this when a whole category would be larger than you need.",
      inputSchema: {
        names: z.array(z.string()).min(1).describe("Operation names to mount."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ names }) => {
      try {
        return textResult({ mounted: await registry.enableOperations(names) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "disable_operations",
    {
      title: "Disable operations",
      description: "Remove cc_<slug> tools for the named operations. Always-on tools are never removed.",
      inputSchema: {
        names: z.array(z.string()).min(1).describe("Operation names to unmount."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ names }) => {
      try {
        return textResult({ removed: await registry.disableOperations(names) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const recipeStep = z.object({
    op: z.string().describe("Operation name."),
    args: z.any().optional().describe("Positional argument list or named argument object."),
  });

  server.registerTool(
    "save_recipe",
    {
      title: "Save recipe",
      description: "Store a named recipe on disk. Saving the same name again replaces the stored steps. The file is CYBERCHEF_RECIPE_PATH, or ~/.cyberchef/recipes.json when that variable is unset.",
      inputSchema: {
        name: z.string().describe("Name used to load the recipe later. Matching ignores case."),
        recipe: z.array(recipeStep).min(1).describe("Recipe steps in order, the same shape bake accepts."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, recipe }) => {
      try {
        return textResult(saveRecipe(name, recipe));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "load_recipe",
    {
      title: "Load recipe",
      description: "Return a previously saved recipe. Pass the recipe array to bake to run it. The name match ignores case.",
      inputSchema: {
        name: z.string().describe("Saved recipe name."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        return textResult(loadRecipe(name));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_recipes",
    {
      title: "List recipes",
      description: "List saved recipe names and how many steps each one has.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return textResult({ recipes: listRecipes() });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_recipe",
    {
      title: "Delete recipe",
      description: "Remove one saved recipe from disk. The name match ignores case.",
      inputSchema: {
        name: z.string().describe("Saved recipe name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        return textResult(deleteRecipe(name));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const registered = new Set(ALWAYS_ON_TOOLS);
  if (registered.size !== ALWAYS_ON_TOOLS.length) {
    throw new Error("Always-on CyberChef tools must stay unique.");
  }
  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createChefServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
