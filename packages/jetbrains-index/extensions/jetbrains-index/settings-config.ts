/**
 * Load JetBrains index MCP service configuration from Pi settings.json,
 * with fallback to the legacy mcp.json for transition.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JetBrainsServiceConfig = {
	url: string;
	headers: Record<string, string>;
	source: "settings.json" | "mcp.json";
	configPath: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const JETBRAINS_INDEX_SERVER_NAME = "jetbrains-index";

function readJson(path: string): unknown {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
}

function resolveHeaderValue(raw: string): string {
	const envRef = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (!envRef) {
		return raw;
	}
	return process.env[envRef[1]] ?? "";
}

function toHeaders(input: unknown): Record<string, string> {
	if (!(input && typeof input === "object")) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (typeof value === "string") {
			headers[key] = resolveHeaderValue(value);
		}
	}
	return headers;
}

function findInMcpJson(configPath: string): { url: string; headers: Record<string, string>; configPath: string } | null {
	const parsed = readJson(configPath);
	if (!(parsed && typeof parsed === "object")) {
		return null;
	}

	const mcpServers = (parsed as Record<string, unknown>).mcpServers;
	if (!(mcpServers && typeof mcpServers === "object")) {
		return null;
	}

	const server = (mcpServers as Record<string, unknown>)[JETBRAINS_INDEX_SERVER_NAME];
	if (!(server && typeof server === "object")) {
		return null;
	}

	const url = (server as Record<string, unknown>).url;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
		return null;
	}

	return {
		url: url.trim(),
		headers: toHeaders((server as Record<string, unknown>).headers),
		configPath,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load JetBrains index MCP service configuration.
 *
 * Priority:
 *  1. Pi `settings.json` — key `jetbrainsIndex` (project overrides global)
 *  2. Legacy `mcp.json` — key `mcpServers.jetbrains-index` (transition fallback)
 *
 * In both files, header values can reference environment variables as
 * `${VAR_NAME}` — references are expanded at load time.
 */
export function loadJetBrainsConfig(cwd: string): JetBrainsServiceConfig | null {
	// Prefer: settings.json > jetbrainsIndex
	const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectSettingsPath = join(cwd, ".pi", "settings.json");

	const globalSettings = readJson(globalSettingsPath);
	const projectSettings = readJson(projectSettingsPath);

	const globalJb = globalSettings && typeof globalSettings === "object"
		? (globalSettings as Record<string, unknown>).jetbrainsIndex
		: undefined;
	const projectJb = projectSettings && typeof projectSettings === "object"
		? (projectSettings as Record<string, unknown>).jetbrainsIndex
		: undefined;

	// Merge project over global (one level deep for url/headers)
	const jbConfig: Record<string, unknown> = {
		...(typeof globalJb === "object" && globalJb ? (globalJb as Record<string, unknown>) : {}),
		...(typeof projectJb === "object" && projectJb ? (projectJb as Record<string, unknown>) : {}),
	};

	if (
		Object.keys(jbConfig).length > 0 &&
		typeof jbConfig.url === "string" &&
		/^https?:\/\//i.test(jbConfig.url)
	) {
		return {
			url: (jbConfig.url as string).trim(),
			headers: toHeaders(jbConfig.headers),
			source: "settings.json",
			configPath: projectJb ? projectSettingsPath : globalSettingsPath,
		};
	}

	// Fallback: try legacy mcp.json
	const mcpConfigPaths = [
		join(cwd, ".pi", "mcp.json"),
		join(homedir(), ".pi", "agent", "mcp.json"),
	];

	for (const mcpPath of mcpConfigPaths) {
		const found = findInMcpJson(mcpPath);
		if (found) {
			return {
				...found,
				source: "mcp.json",
			};
		}
	}

	return null;
}
