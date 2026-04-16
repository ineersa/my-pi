import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type JetBrainsMcpServerConfig = {
	serverName: string;
	sseUrl: string;
	headers: Record<string, string>;
	configPath: string;
};

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

function findJetBrainsIndexInConfig(configPath: string): JetBrainsMcpServerConfig | null {
	const parsed = readJson(configPath);
	if (!(parsed && typeof parsed === "object")) {
		return null;
	}

	const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (!(mcpServers && typeof mcpServers === "object")) {
		return null;
	}

	const server = (mcpServers as Record<string, unknown>)[JETBRAINS_INDEX_SERVER_NAME];
	if (!(server && typeof server === "object")) {
		return null;
	}

	const url = (server as { url?: unknown }).url;
	if (typeof url !== "string") {
		return null;
	}

	const streamableUrl = url.trim();
	if (!streamableUrl || !/^https?:\/\//i.test(streamableUrl)) {
		return null;
	}

	return {
		serverName: JETBRAINS_INDEX_SERVER_NAME,
		sseUrl: streamableUrl,
		headers: toHeaders((server as { headers?: unknown }).headers),
		configPath,
	};
}

export function findJetBrainsMcpServer(cwd: string): JetBrainsMcpServerConfig | null {
	const configPaths = [
		join(cwd, ".pi", "mcp.json"),
		join(homedir(), ".pi", "agent", "mcp.json"),
	];

	for (const configPath of configPaths) {
		const config = findJetBrainsIndexInConfig(configPath);
		if (config) {
			return config;
		}
	}

	return null;
}
