/**
 * Shared MCP state bridge via globalThis.
 * Minimal shim: reads from globalThis without importing from pi-mcp-adapter.
 * The pi-mcp-adapter standalone package writes state via setMcpState.
 */

export interface McpServerStatus {
  name: string;
  status: string;
  icon: string;
  tools?: number;
}

const GLOBAL_KEY = "__my_pi_mcp_state__" as const;

/** Get current MCP server status list (safe to call anytime). */
export function getMcpServerStatus(): McpServerStatus[] {
  const state = (globalThis as any)[GLOBAL_KEY] as {
    config: { mcpServers: Record<string, { enabled?: boolean; [key: string]: unknown }> };
    manager: { getConnection(name: string): { status: string } | undefined };
    toolMetadata: Map<string, unknown[]>;
    failureTracker: Map<string, number>;
  } | null | undefined;

  if (!state) return [];

  const FAILURE_BACKOFF_MS = 60_000;
  const servers: McpServerStatus[] = [];

  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    const enabled = definition.enabled !== false;
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;

    let failedAgo: number | null = null;
    const failedAt = state.failureTracker.get(name);
    if (failedAt) {
      const ageMs = Date.now() - failedAt;
      if (ageMs <= FAILURE_BACKOFF_MS) failedAgo = Math.round(ageMs / 1000);
    }

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
