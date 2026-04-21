/**
 * Lightweight agent name discovery — scans user/project agent dirs
 * for .md files with YAML frontmatter containing a `name` field.
 *
 * This is used by compact-header for the header widget display.
 * Full agent config resolution is handled by pi-subagents at runtime.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const USER_DIRS = [
	path.join(os.homedir(), ".pi", "agent", "agents"),
	path.join(os.homedir(), ".agents"),
];

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const piAgents = path.join(dir, ".pi", "agents");
		if (isDirectory(piAgents)) return piAgents;
		const dotAgents = path.join(dir, ".agents");
		if (isDirectory(dotAgents)) return dotAgents;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function extractNameFromFrontmatter(content: string): string | null {
	// Quick frontmatter name extraction — no need for full YAML parse
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("---", 3);
	if (end === -1) return null;
	const fm = content.slice(3, end);
	for (const line of fm.split("\n")) {
		const match = line.match(/^name:\s*(.+)$/);
		if (match) return match[1]!.trim();
	}
	return null;
}

function scanDirForNames(dir: string): string[] {
	if (!isDirectory(dir)) return [];
	const names: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			try {
				const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
				const name = extractNameFromFrontmatter(content);
				if (name) names.push(name);
			} catch {
				// skip unreadable files
			}
		}
	} catch {
		// skip unreadable dirs
	}
	return names;
}

/**
 * Discover agent names from user and project directories.
 * Deduplicates by name (project takes priority over user).
 */
export function discoverAvailableAgentNames(cwd: string): string[] {
	const seen = new Set<string>();
	const names: string[] = [];

	// Project agents first (highest priority)
	const projectDir = findNearestProjectAgentsDir(cwd);
	if (projectDir) {
		for (const name of scanDirForNames(projectDir)) {
			if (!seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
	}

	// User agents
	for (const dir of USER_DIRS) {
		for (const name of scanDirForNames(dir)) {
			if (!seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
	}

	return names;
}
