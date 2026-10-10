/**
 * CyberChef 11.5.0's postinstall calls grunt, which is not installed when the
 * package is consumed as a dependency. These two patches are the postinstall
 * steps that the Node API actually needs, applied idempotently.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function packageDirs(name) {
  const found = [];
  const top = path.join(root, "node_modules");
  const direct = path.join(top, name);
  if (existsSync(path.join(direct, "package.json"))) found.push(direct);
  if (!existsSync(top)) return found;
  for (const entry of readdirSync(top)) {
    if (entry.startsWith(".")) continue;
    const nestedRoot = entry.startsWith("@")
      ? path.join(top, entry)
      : path.join(top, entry, "node_modules");
    if (!existsSync(nestedRoot) || !statSync(nestedRoot).isDirectory()) continue;
    const scope = entry.startsWith("@") ? readdirSync(nestedRoot) : [path.basename(path.dirname(nestedRoot))];
    const parents = entry.startsWith("@")
      ? scope.map((child) => path.join(nestedRoot, child, "node_modules", name))
      : [path.join(top, entry, "node_modules", name)];
    for (const candidate of parents) {
      if (existsSync(path.join(candidate, "package.json"))) found.push(candidate);
    }
  }
  return found;
}

function patchCryptoApi(dir) {
  const base = path.join(dir, "src");
  if (!existsSync(base)) return 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(fullPath);
        continue;
      }
      const content = readFileSync(fullPath, "utf8");
      const updated = content.replace(/from "(\.[^"]*)";/g, (match, specifier) => {
        if (specifier.endsWith(".mjs") || specifier.endsWith(".js") || specifier.endsWith(".json")) return match;
        return `from "${specifier}.mjs";`;
      });
      if (updated !== content) {
        writeFileSync(fullPath, updated);
        files += 1;
      }
    }
  };
  walk(base);
  return files;
}

function patchSnackbar(dir) {
  const filePath = path.join(dir, "src", "snackbar.js");
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf8");
  const updated = content.replace(/<div id=snackbar-container\/>/g, "<div id=snackbar-container>");
  if (updated !== content) writeFileSync(filePath, updated);
  return true;
}

const cryptoDirs = packageDirs("crypto-api");
if (cryptoDirs.length === 0) {
  console.error("repair-cyberchef: crypto-api was not found. Run npm install --ignore-scripts first.");
  process.exit(1);
}
let patched = 0;
for (const dir of cryptoDirs) patched += patchCryptoApi(dir);
for (const dir of packageDirs("snackbarjs")) patchSnackbar(dir);
console.error(`repair-cyberchef: crypto-api packages ${cryptoDirs.length}, files updated ${patched}`);
