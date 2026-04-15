import type { AgentToolResult, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { ToolMetadata, McpContent } from "./types.js";
import { getServerPrefix } from "./types.js";
import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.js";
import { buildToolMetadata, getToolNames, findToolByName, formatSchema } from "./tool-metadata.js";
import { transformMcpContent } from "./tool-registrar.js";
import { truncateAtWord } from "./utils.js";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

function getAuthRequiredMessage(serverName: string): string {
  return `Server "${serverName}" requires auth and is not supported in this build.`;
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }> = [];

  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    const enabled = definition.enabled !== false;
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    if (!enabled) {
      status = "disabled";
    } else if (connection?.status === "connected") {
      status = "connected";
    } else if (connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (failedAgo !== null) {
      status = "failed";
    } else if (metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo });
  }

  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "disabled") {
      text += `⏸ ${server.name} (disabled)\n`;
      continue;
    }
    if (server.status === "needs-auth") {
      text += `⚠ ${server.name} (requires auth; disabled in this build)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not connected)\n`;
  }

  if (servers.length > 0) {
    text += "\nmcp({ server: \"name\" }) to list tools, mcp({ search: \"...\" }) to search";
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount },
  };
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;

  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = findToolByName(metadata, toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }

  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
    };
  }

  let text = `${toolMeta.name}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;

  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
  } else if (toolMeta.resourceUri) {
    text += "\nNo parameters required (resource tool).";
  } else {
    text += "\nNo parameters defined.";
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

export function executeSearch(
  state: McpExtensionState,
  query: string,
  regex?: boolean,
  server?: string,
  includeSchemas?: boolean,
  getPiTools?: () => ToolInfo[],
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;

  const matches: Array<{ server: string; tool: ToolMetadata }> = [];

  let pattern: RegExp;
  try {
    if (regex) {
      pattern = new RegExp(query, "i");
    } else {
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }

  const piMatches: Array<{ name: string; description: string }> = [];
  if (!server && getPiTools) {
    const piTools = getPiTools();
    for (const tool of piTools) {
      if (tool.name === "mcp") continue;

      if (pattern.test(tool.name) || pattern.test(tool.description ?? "")) {
        piMatches.push({
          name: tool.name,
          description: tool.description ?? "",
        });
      }
    }
  }

  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    for (const tool of metadata) {
      if (pattern.test(tool.name) || pattern.test(tool.description)) {
        matches.push({ server: serverName, tool });
      }
    }
  }

  const totalCount = piMatches.length + matches.length;

  if (totalCount === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }

  let text = `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`;

  for (const match of piMatches) {
    if (showSchemas) {
      text += `[pi tool] ${match.name}\n`;
      text += `  ${match.description || "(no description)"}\n`;
      text += "  No parameters (call directly).\n\n";
    } else {
      text += `[pi tool] ${match.name}`;
      if (match.description) {
        text += ` - ${truncateAtWord(match.description, 50)}`;
      }
      text += "\n";
    }
  }

  for (const match of matches) {
    if (showSchemas) {
      text += `${match.tool.name}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`;
      } else if (match.tool.resourceUri) {
        text += "  No parameters (resource tool).\n";
      }
      text += "\n";
    } else {
      text += `- ${match.tool.name}`;
      if (match.tool.description) {
        text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      }
      text += "\n";
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "search",
      matches: [
        ...piMatches.map(m => ({ server: "pi", tool: m.name })),
        ...matches.map(m => ({ server: m.server, tool: m.tool.name })),
      ],
      count: totalCount,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }

  const definition = state.config.mcpServers[server];
  if (definition.enabled === false) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is disabled in config.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "disabled" },
    };
  }

  const metadata = state.toolMetadata.get(server);
  const toolNames = metadata?.map(m => m.name) ?? [];
  const connection = state.manager.getConnection(server);

  if (toolNames.length === 0) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
        details: { mode: "list", server, tools: [], count: 0 },
      };
    }
    if (metadata !== undefined) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
  let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

  const descMap = new Map<string, string>();
  if (metadata) {
    for (const m of metadata) {
      descMap.set(m.name, m.description);
    }
  }

  for (const tool of toolNames) {
    const desc = descMap.get(tool) ?? "";
    const truncated = truncateAtWord(desc, 50);
    text += `- ${tool}`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "list", server, tools: toolNames, count: toolNames.length },
  };
}

export async function executeConnect(state: McpExtensionState, serverName: string): Promise<ProxyToolResult> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }
  if (definition.enabled === false) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" is disabled in config.` }],
      details: { mode: "connect", error: "disabled", server: serverName },
    };
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    const connection = await state.manager.connect(serverName, definition);
    if (connection.status === "needs-auth") {
      const message = getAuthRequiredMessage(serverName);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "connect", error: "auth_required", server: serverName, message },
      };
    }
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: "connect_failed", server: serverName, message },
    };
  }
}

export async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string,
): Promise<ProxyToolResult> {
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName },
    };
  }

  if (serverName) {
    const serverDef = state.config.mcpServers[serverName];
    if (serverDef?.enabled === false) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" is disabled in config.` }],
        details: { mode: "call", error: "disabled", server: serverName },
      };
    }
    toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
  } else {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (found) {
        serverName = server;
        toolMeta = found;
        break;
      }
    }
  }

  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const candidates = Object.keys(state.config.mcpServers)
      .filter(name => state.config.mcpServers[name].enabled !== false)
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const existingConnection = state.manager.getConnection(configuredServer);
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

      const connected = await lazyConnect(state, configuredServer);
      if (!connected) continue;
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
      if (toolMeta) {
        serverName = configuredServer;
        break;
      }
    }
  }

  if (!serverName || !toolMeta) {
    const hintServer = serverName ?? prefixMatchedServer;
    const available = hintServer ? getToolNames(state, hintServer) : [];
    let msg = `Tool "${toolName}" not found.`;
    if (available.length > 0) {
      msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
    } else {
      msg += " Use mcp({ search: \"...\" }) to search.";
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
    };
  }

  let connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    const message = getAuthRequiredMessage(serverName);
    return {
      content: [{ type: "text" as const, text: message }],
      details: { mode: "call", error: "auth_required", server: serverName, message },
    };
  }
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", server: serverName },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition || definition.enabled === false) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", server: serverName },
      };
    }

    try {
      if (state.ui) {
        state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
      }
      connection = await state.manager.connect(serverName, definition);
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "call", error: "auth_required", server: serverName, message },
        };
      }
      state.failureTracker.delete(serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      updateStatusBar(state);
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
        };
      }
    } catch (error) {
      state.failureTracker.set(serverName, Date.now());
      updateStatusBar(state);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: "connect_failed", message },
      };
    }
  }

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    if (toolMeta.resourceUri) {
      const result = await connection.client.readResource({ uri: toolMeta.resourceUri });
      const content = (result.contents ?? []).map(c => ({
        type: "text" as const,
        text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
      }));
      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
        details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName },
      };
    }

    const result = await connection.client.callTool({
      name: toolMeta.originalName,
      arguments: args ?? {},
    });

    const mcpContent = (result.content ?? []) as McpContent[];
    const content = transformMcpContent(mcpContent);

    if (result.isError) {
      const errorText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n") || "Tool execution failed";

      let errorWithSchema = `Error: ${errorText}`;
      if (toolMeta.inputSchema) {
        errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
      }

      return {
        content: [{ type: "text" as const, text: errorWithSchema }],
        details: { mode: "call", error: "tool_error", mcpResult: result },
      };
    }

    return {
      content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
      details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    let errorWithSchema = `Failed to call tool: ${message}`;
    if (toolMeta.inputSchema) {
      errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
    }

    return {
      content: [{ type: "text" as const, text: errorWithSchema }],
      details: { mode: "call", error: "call_failed", message },
    };
  } finally {
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
  }
}
