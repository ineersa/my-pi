#!/usr/bin/env node

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const sourceDir = resolve(repoRoot, ".agents");
const targetDir = resolve(packageRoot, ".agents");

if (!existsSync(sourceDir)) {
	console.error(`Source agents directory not found: ${sourceDir}`);
	process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.error(`Synced ${sourceDir} -> ${targetDir}`);
