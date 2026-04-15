import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { ServerEntry } from "./types.js";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.js";
import { buildToolMetadata } from "./tool-metadata.js";

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = [
    "MCP Server Status:",
    "",
    "Commands:",
    "  /mcp                 → Show server status",
    "  /mcp tools           → List all available tools",
    "  /mcp reconnect       → Reconnect all enabled servers",
    "  /mcp reconnect <id>  → Reconnect a specific server",
    "",
  ];

  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    const enabled = definition.enabled !== false;
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (!enabled) {
      status = "disabled";
      statusIcon = "⏸";
    } else if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed || !enabled ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers).filter(([, definition]) => definition.enabled !== false);

  for (const [name, definition] of entries) {
    if (definition.enabled === false) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: ${name} is disabled in config`, "info");
      }
      continue;
    }

    try {
      await state.manager.close(name);

      const connected = await lazyConnect(state, name);
      if (!connected) {
        const connection = state.manager.getConnection(name);
        if (connection?.status === "needs-auth" && ctx.hasUI) {
          ctx.ui.notify(`MCP: ${name} requires auth and is not supported in this build.`, "warning");
        }
        continue;
      }

      const connection = state.manager.getConnection(name);
      if (!connection || connection.status !== "connected") {
        continue;
      }

      const prefix = state.config.settings?.toolPrefix ?? "server";
      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }

  updateStatusBar(state);
}
