/**
 * MCP tool name resolution helpers for subagent child sessions.
 *
 * Subagents need to build the correct --tools allowlist and MCP_DIRECT_TOOLS
 * env var for child pi processes. This module provides:
 *
 * 1) Conversion between visible tool names (e.g. "websearch__search") and
 *    MCP_DIRECT_TOOLS env spec format (e.g. "websearch/search").
 *
 * 2) Resolution of configured direct tool names from MCP config + metadata
 *    cache, mirroring pi-mcp-adapter's resolveDirectTools() early-registration
 *    logic for case C (mcp:* wildcard).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Name conversion
// ============================================================================

/**
 * Convert a visible MCP tool name (e.g. "websearch__search") to the
 * MCP_DIRECT_TOOLS env spec format (e.g. "websearch/search").
 *
 * Splits at the first "__" separator. If no "__" is found, passes through.
 */
export function visibleToolToEnvSpec(visible: string): string {
	const idx = visible.indexOf("__");
	if (idx === -1) return visible;
	return visible.slice(0, idx) + "/" + visible.slice(idx + 2);
}

// ============================================================================
// Resolve configured direct tool names
// ============================================================================

/**
 * Try to resolve the visible names of configured direct MCP tools by reading
 * the MCP config and metadata cache (same sources as pi-mcp-adapter).
 *
 * Returns an array of visible tool names (e.g. ["websearch__search"])
 * that are configured as direct tools via server-level `directTools` setting.
 *
 * Returns empty array if the config, cache, or tool list cannot be resolved
 * (best-effort — the child session will still work with ToolSearch alone).
 */
export function resolveConfiguredDirectToolNames(): string[] {
	const configPath = join(homedir(), ".pi", "agent", "mcp.json");
	if (!existsSync(configPath)) return [];

	let config: Record<string, unknown> | undefined;
	try {
		config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return [];
	}

	const mcpServers = (config?.mcpServers ?? config?.["mcp-servers"] ?? {}) as Record<string, unknown>;
	if (typeof mcpServers !== "object" || mcpServers === null) return [];

	// Determine tool prefix mode
	const settings = config?.settings as Record<string, unknown> | undefined;
	const prefixMode: "server" | "none" | "short" = (settings?.toolPrefix as "server" | "none" | "short") ?? "server";

	// Read metadata cache
	const cachePath = join(homedir(), ".pi", "agent", "mcp-cache.json");
	let cache: Record<string, unknown> | undefined;
	try {
		if (existsSync(cachePath)) {
			cache = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, unknown>;
		}
	} catch {
		// Cache is optional
	}

	const serverCaches = (cache?.servers ?? {}) as Record<string, { tools?: Array<{ name: string }>; cachedAt?: number }>;
	const visibleNames: string[] = [];

	for (const [serverName, entry] of Object.entries(mcpServers)) {
		if (typeof entry !== "object" || entry === null) continue;
		const def = entry as Record<string, unknown>;
		if (def.enabled === false) continue;

		// Check if this server has configured direct tools
		let directTools: string[] | boolean | undefined;
		if (Array.isArray(def.directTools)) {
			directTools = def.directTools;
		} else if (def.directTools === true) {
			directTools = true;
		} else {
			continue; // no configured direct tools for this server
		}

		// Get the server's tool list from cache
		const serverCache = serverCaches[serverName];
		if (!serverCache?.tools) continue;

		// Compute prefix
		let prefix: string;
		if (prefixMode === "none") {
			prefix = "";
		} else if (prefixMode === "short") {
			prefix = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
			if (!prefix) prefix = "mcp";
		} else {
			prefix = serverName.replace(/-/g, "_");
		}

		for (const tool of serverCache.tools) {
			const toolName = tool.name;
			if (!toolName) continue;

			// Apply directTools filter
			if (directTools !== true && Array.isArray(directTools) && !directTools.includes(toolName)) {
				continue;
			}

			const visibleName = prefix ? `${prefix}__${toolName}` : toolName;
			visibleNames.push(visibleName);
		}
	}

	return visibleNames;
}
