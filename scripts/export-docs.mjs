/**
 * Write docs/tools.json and docs/operations.json from the running server.
 * tools.json is the MCP tool list. operations.json is every catalog operation and its arguments.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeOperation, searchOperations } from "../src/catalog.ts";
import { shutdownWorkers } from "../src/execute.ts";
import { createChefServer } from "../src/server.ts";

const docs = path.resolve(import.meta.dirname, "../docs");

function writeJson(name, value) {
  writeFileSync(path.join(docs, name), `${JSON.stringify(value, null, 2)}\n`);
}

const server = createChefServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "cyberchef-docs", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
} while (cursor);

writeJson("tools.json", {
  server: "cyberchef",
  tools,
  mountedTools: {
    name: "cc_<slug>",
    addedBy: ["enable_category", "enable_operations"],
    removedBy: ["disable_category", "disable_operations"],
    arguments: "input, inputEncoding, inputPath, and outputPath, plus one field for each CyberChef argument. The field name is the argument name. Argument definitions are in operations.json.",
  },
});

const hits = searchOperations();
const operations = [];
for (const hit of hits) {
  const described = await describeOperation(hit.name);
  operations.push({
    name: described.name,
    category: hit.category,
    available: described.available,
    ...(described.unavailableReason ? { unavailableReason: described.unavailableReason } : {}),
    inputType: described.inputType,
    outputType: described.outputType,
    args: described.args,
  });
}

writeJson("operations.json", {
  source: "CyberChef 11.5.0 Categories.json and chef.help",
  count: operations.length,
  operations,
});

await client.close();
await server.close();
await shutdownWorkers();
console.error(`export-docs: ${tools.length} tools, ${operations.length} operations`);
