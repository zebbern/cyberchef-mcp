/**
 * Fetch CyberChef 11.5.0 without running its postinstall.
 * That script calls grunt and fails when CyberChef is installed as a dependency.
 * repair-cyberchef.mjs applies the two patches the Node API needs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const VERSION = "11.5.0";
const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "node_modules", "cyberchef");
const packagePath = path.join(destination, "package.json");

function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

const cryptoApi = path.join(destination, "node_modules", "crypto-api", "package.json");
if (installedVersion() === VERSION && existsSync(cryptoApi)) {
  console.error(`install-cyberchef: cyberchef ${VERSION} already present`);
  process.exit(0);
}

const tarball = path.join(tmpdir(), `cyberchef-${VERSION}-${process.pid}.tgz`);
const url = `https://registry.npmjs.org/cyberchef/-/cyberchef-${VERSION}.tgz`;
console.error(`install-cyberchef: downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`install-cyberchef: download failed with HTTP ${response.status}`);
  process.exit(1);
}
writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], { stdio: "inherit" });
rmSync(tarball, { force: true });

if (installedVersion() !== VERSION) {
  console.error(`install-cyberchef: expected cyberchef ${VERSION} in ${destination}`);
  process.exit(1);
}

function npmCli() {
  const besideNode = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(besideNode)) return besideNode;
  console.error("install-cyberchef: npm was not found next to node.");
  process.exit(1);
}

console.error("install-cyberchef: installing CyberChef dependencies without lifecycle scripts");
execFileSync(process.execPath, [npmCli(), "install", "--ignore-scripts", "--omit=dev", "--no-fund", "--no-audit"], {
  cwd: destination,
  stdio: "inherit",
  env: process.env,
});
console.error(`install-cyberchef: extracted cyberchef ${VERSION}`);
