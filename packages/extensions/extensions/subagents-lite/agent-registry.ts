/**
 * Agent discovery: load .md agent files from builtin, user, and project dirs.
 * Precedence: builtin < user < project (last write wins on name collision).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "./lib/frontmatter.js";
import type { AgentConfig, AgentSource } from "./types.js";

// Resolve builtin agents directory relative to this file.
// Since this is loaded by pi (JITI/tsx), __dirname is available.
const BUILTIN_AGENTS_DIR = path.join(
	typeof __dirname !== "undefined" ? __dirname : path.dirname(process.argv[1] ?? ""),
	"agents",
);

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (
			isDirectory(path.join(currentDir, ".pi")) ||
			isDirectory(path.join(currentDir, ".agents"))
		) {
			return currentDir;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return null;
	const candidateAlt = path.join(projectRoot, ".agents");
	if (isDirectory(candidateAlt)) return candidateAlt;
	const candidate = path.join(projectRoot, ".pi", "agents");
	return isDirectory(candidate) ? candidate : null;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
		});
	}

	return agents;
}

export interface AgentConflictEntry {
	name: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentConflict {
	name: string;
	winner: AgentConflictEntry;
	overridden: AgentConflictEntry[];
}

export interface AgentDiscoveryMetadata {
	loadedFrom: {
		builtin?: string;
		user: string[];
		project?: string;
	};
	conflicts: AgentConflict[];
}

export interface AgentDiscoveryResult extends AgentDiscoveryMetadata {
	agents: AgentConfig[];
}

function getUserAgentDirs(): string[] {
	return [
		path.join(os.homedir(), ".agents"),
		path.join(os.homedir(), ".pi", "agent", "agents"),
	];
}

function toConflictEntry(agent: AgentConfig): AgentConflictEntry {
	return {
		name: agent.name,
		source: agent.source,
		filePath: agent.filePath,
	};
}

/**
 * Discover all available agents with precedence: builtin < user < project.
 * Returns resolved agents (winner per name), plus source/conflict metadata.
 */
export function discoverAgentsWithMetadata(cwd: string): AgentDiscoveryResult {
	const agentMap = new Map<string, AgentConfig>();
	const occurrences = new Map<string, AgentConfig[]>();
	const loadedFrom: AgentDiscoveryMetadata["loadedFrom"] = {
		user: [],
	};

	const registerBatch = (dir: string, source: AgentSource): void => {
		const batch = loadAgentsFromDir(dir, source);
		if (batch.length === 0) return;

		if (source === "builtin") {
			loadedFrom.builtin = dir;
		} else if (source === "project") {
			loadedFrom.project = dir;
		} else if (!loadedFrom.user.includes(dir)) {
			loadedFrom.user.push(dir);
		}

		for (const agent of batch) {
			const existing = occurrences.get(agent.name) ?? [];
			existing.push(agent);
			occurrences.set(agent.name, existing);
			agentMap.set(agent.name, agent);
		}
	};

	registerBatch(BUILTIN_AGENTS_DIR, "builtin");
	for (const userDir of getUserAgentDirs()) {
		registerBatch(userDir, "user");
	}
	const projectDir = findNearestProjectAgentsDir(cwd);
	if (projectDir) {
		registerBatch(projectDir, "project");
	}

	const conflicts: AgentConflict[] = [];
	for (const [name, seen] of occurrences) {
		if (seen.length <= 1) continue;
		const winner = seen[seen.length - 1]!;
		conflicts.push({
			name,
			winner: toConflictEntry(winner),
			overridden: seen.slice(0, -1).map(toConflictEntry),
		});
	}
	conflicts.sort((a, b) => a.name.localeCompare(b.name));

	const agents = Array.from(agentMap.values()).sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	return {
		agents,
		loadedFrom,
		conflicts,
	};
}

/**
 * Discover all available agents with precedence: builtin < user < project.
 * Returns a sorted list (by name ascending).
 */
export function discoverAgents(cwd: string): AgentConfig[] {
	return discoverAgentsWithMetadata(cwd).agents;
}

/**
 * Get a single agent by name. Returns undefined if not found.
 */
export function getAgentByName(
	name: string,
	cwd: string,
): AgentConfig | undefined {
	return discoverAgents(cwd).find((a) => a.name === name);
}
