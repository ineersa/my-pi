#!/usr/bin/env node
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const mode = process.argv[2] || "pull";
const repoPiDir = resolve(process.cwd(), "pi-settings");
const globalPiDir = resolve(homedir(), ".pi");
const localPiDir = resolve(process.cwd(), ".pi");

const AGENT_FILES = [
	"compaction-policy.json",
	"mcp.json",
	"models.json",
	"safe-guard.json",
	"settings.json",
];

const AGENT_DIRS = [
	"prompts",
];

function copyFile(src, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
}

function copyDirFiltered(src, dest) {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		if (entry.name === "auth.json") continue;
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirFiltered(srcPath, destPath);
		} else if (entry.isFile()) {
			copyFile(srcPath, destPath);
		}
	}
}

// ── Project-local .pi copy (copy:settings <target-dir>) ──────────────

if (mode !== "pull" && mode !== "push") {
	const targetDir = resolve(process.cwd(), mode);

	if (!existsSync(localPiDir)) {
		console.error(`Source .pi directory not found: ${localPiDir}`);
		process.exit(1);
	}

	const targetPiDir = join(targetDir, ".pi");
	mkdirSync(targetDir, { recursive: true });
	rmSync(targetPiDir, { recursive: true, force: true });
	cpSync(localPiDir, targetPiDir, { recursive: true });

	console.log(`Copied ${localPiDir} -> ${targetPiDir}`);
	process.exit(0);
}

// ── Global pi-settings pull/push ──────────────────────────────────────

if (mode === "pull") {
	let copied = 0;
	for (const file of AGENT_FILES) {
		const src = join(globalPiDir, "agent", file);
		if (!existsSync(src)) continue;
		copyFile(src, join(repoPiDir, "agent", file));
		copied++;
	}
	for (const dir of AGENT_DIRS) {
		const src = join(globalPiDir, "agent", dir);
		if (!existsSync(src)) continue;
		copyDirFiltered(src, join(repoPiDir, "agent", dir));
		copied++;
	}
	console.log(`Pulled ${copied} item(s) from ${globalPiDir}/agent -> ${repoPiDir}/agent`);
	process.exit(0);
}

if (mode === "push") {
	let copied = 0;
	for (const file of AGENT_FILES) {
		const src = join(repoPiDir, "agent", file);
		if (!existsSync(src)) continue;
		copyFile(src, join(globalPiDir, "agent", file));
		copied++;
	}
	for (const dir of AGENT_DIRS) {
		const src = join(repoPiDir, "agent", dir);
		if (!existsSync(src)) continue;
		copyDirFiltered(src, join(globalPiDir, "agent", dir));
		copied++;
	}
	console.log(`Pushed ${copied} item(s) from ${repoPiDir}/agent -> ${globalPiDir}/agent`);
	process.exit(0);
}
