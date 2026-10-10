#!/usr/bin/env node
import { startStdioServer } from "./server.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 24 || major >= 27) {
  console.error(`cyberchef requires Node.js >=24 <27. Current version is ${process.versions.node}.`);
  process.exit(1);
}

startStdioServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
