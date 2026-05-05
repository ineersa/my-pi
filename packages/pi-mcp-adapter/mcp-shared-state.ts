/**
 * Shared MCP state bridge via globalThis.
 * Avoids module-instance issues across pi extensions.
 */
import type { McpExtensionState } from "./state.js";

const FAILURE_BACKOFF_MS = 60_000;

export interface McpServerStatus {
	name: string;
	status: string;
	icon: string;
	tools?: number;
}

const GLOBAL_KEY = "__my_pi_mcp_state__" as const;

function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
	const failedAt = state.failureTracker.get(serverName);
	if (!failedAt) return null;
	const ageMs = Date.now() - failedAt;
	if (ageMs > FAILURE_BACKOFF_MS) return null;
	return Math.round(ageMs / 1000);
}

/** Called by the MCP adapter when state changes. */
export function setMcpState(state: McpExtensionState | null): void {
	(globalThis as any)[GLOBAL_KEY] = state;
}

/** Get current MCP server status list (safe to call anytime). */
export function getMcpServerStatus(): McpServerStatus[] {
	const state = (globalThis as any)[GLOBAL_KEY] as McpExtensionState | null | undefined;
	if (!state) {
		return [];
	}

	const servers: McpServerStatus[] = [];

	for (const [name, definition] of Object.entries(state.config.mcpServers)) {
		const enabled = definition.enabled !== false;
		const connection = state.manager.getConnection(name);
		const metadata = state.toolMetadata.get(name);
		const toolCount = metadata?.length ?? 0;
		const failedAgo = getFailureAgeSeconds(state, name);

		let status = "not connected";
		let icon = "○";
		let tools: number | undefined;

		if (!enabled) {
			status = "disabled";
			icon = "⏸";
		} else if (connection?.status === "connected") {
			status = "connected";
			icon = "✓";
			tools = toolCount;
		} else if (failedAgo !== null) {
			status = `failed ${failedAgo}s ago`;
			icon = "✗";
		} else if (metadata !== undefined) {
			status = "cached";
			tools = toolCount;
		}

		servers.push({ name, status, icon, tools });
	}

	return servers;
}
