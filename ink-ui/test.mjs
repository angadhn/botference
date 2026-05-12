import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function major(version) {
  return Number.parseInt(version.split(".")[0] ?? "0", 10);
}

const currentNode = process.execPath;
const fallbackNode = "/opt/homebrew/bin/node";
let nodeBin = currentNode;
if (major(process.versions.node) < 18) {
  if (!existsSync(fallbackNode)) {
    console.error(`Ink UI tests require Node 18+; current node is ${process.version}.`);
    process.exit(1);
  }
  nodeBin = fallbackNode;
}

const testFiles = [
  ...readdirSync("src")
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => join("src", name)),
  ...readdirSync(join("src", "v2"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => join("src", "v2", name)),
].sort();

const result = spawnSync(
  nodeBin,
  ["node_modules/tsx/dist/cli.mjs", "--test", ...testFiles],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
