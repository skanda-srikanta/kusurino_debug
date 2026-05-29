import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const sourceDirectory = path.join(workspaceRoot, "node_modules", "codecorp-web_sdk", "dist", "web");
const targetDirectory = path.join(workspaceRoot, "public", "wasm");

if (!existsSync(sourceDirectory)) {
  throw new Error(`SDK web asset folder not found: ${sourceDirectory}`);
}

mkdirSync(targetDirectory, { recursive: true });

for (const entryName of readdirSync(sourceDirectory)) {
  if (!entryName.endsWith(".wasm")) {
    continue;
  }

  cpSync(path.join(sourceDirectory, entryName), path.join(targetDirectory, entryName));
}

console.log("Copied CortexDecoder WASM assets to public/wasm.");