#!/usr/bin/env node

/**
 * Install pi-subagents extension and remove builtin agents.
 *
 * Usage:
 *   node scripts/install-subagents.mjs          # Install or update
 *   node scripts/install-subagents.mjs --remove # Remove
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");
const AGENTS_DIR = path.join(EXTENSION_DIR, "agents");

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("pi-subagents removed.");
	} else {
		console.log("pi-subagents is not installed.");
	}
	process.exit(0);
}

// Install or update via the package's own installer
console.log("Installing pi-subagents...\n");
execSync("npx pi-subagents", { stdio: "inherit" });

// Nuke builtin agents — we use our own from ~/.pi/agent/agents/
if (fs.existsSync(AGENTS_DIR)) {
	console.log(`\nRemoving builtin agents: ${AGENTS_DIR}`);
	fs.rmSync(AGENTS_DIR, { recursive: true });
	console.log("Builtin agents removed. Your agents in ~/.pi/agent/agents/ will be used instead.");
} else {
	console.log("\nNo builtin agents directory found (already clean).");
}

console.log("\nDone. Tools available: subagent, subagent_status");
