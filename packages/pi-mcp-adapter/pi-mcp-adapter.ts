import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import { Type } from "@sinclair/typebox";
import { showStatus, showTools, reconnectServers } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { createDirectToolExecutor, resolveDirectTools, BUILTIN_NAMES } from "./direct-tools.js";
import { flushMetadataCache, initializeMcp, lazyConnect, updateServerMetadata, updateMetadataCache, updateStatusBar } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.js";
import { createToolSearchTool } from "./tool-search.js";

import { setMcpState } from "./mcp-shared-state.js";

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      currentState.statsTracker?.dispose();
    } catch (error) {
      if (!flushError) {
        flushError = error;
      } else {
        console.error("MCP: stats flush failed after metadata flush error", error);
      }
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  // --- Early config/cache loading (before session_start) ---
  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );

  // Build a set of prefixed direct tool names for filtering in session_start
  const earlyDirectToolNames = new Set(directSpecs.map(s => s.prefixedName));

  // Register direct tools early (before session_start) so they are available immediately
  for (const spec of directSpecs) {
    pi.registerTool({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema || { type: "object", properties: {} }) as any,
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
    });
  }

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  // --- session_start: initialize MCP, register all tools, wire ToolSearch ---
  pi.on("session_start", async (_event, ctx) => {
    // ------------------------------------------------------------------
    // Subagent child-mode MCP control
    // PI_SUBAGENT_MCP_MODE controls whether tool registration and ToolSearch
    // are active in child subagent sessions:
    //   none     = skip ALL MCP initialization (no servers, no tools, no ToolSearch)
    //   specific = init MCP so early direct tools work, but skip catalog +
    //              ToolSearch + setActiveTools (only MCP_DIRECT_TOOLS tools active)
    //   all/unset = normal behavior (full catalog + ToolSearch + config direct tools)
    // ------------------------------------------------------------------
    const subagentMcpMode = process.env.PI_SUBAGENT_MCP_MODE;
    if (subagentMcpMode === "none") {
      return; // Skip ALL MCP initialization for this session
    }

    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(previousState, "session_restart");
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    const promise = initializeMcp(pi, ctx);
    initPromise = promise;

    const isSpecificMode = subagentMcpMode === "specific";

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "session_ended_before_init");
        } catch (error) {
          console.error("MCP: failed to shut down after init completed too late", error);
        }
        return;
      }

      state = nextState;
      setMcpState(nextState);
      initPromise = null;

      // In specific mode, only init state so early direct tools work.
      // Do NOT register the full catalog, ToolSearch, or call setActiveTools.
      if (isSpecificMode) {
        return;
      }

      // Non-null local reference for callbacks (TS narrows from closure)
      const s = state;

      // ----------------------------------------------------------------
      // ToolSearch integration: register ALL tools + ToolSearch, narrow active set
      // ----------------------------------------------------------------

      // 1. Capture active tools BEFORE registering new ones (registerTool auto-activates)
      const builtinActive = pi.getActiveTools();

      // 2. Register ALL MCP tools from metadata with full schemas + direct executors
      const directToolNames: string[] = [];
      for (const [serverName, tools] of state.toolMetadata.entries()) {
        for (const tool of tools) {
          // Skip tools whose prefixed name collides with a builtin
          if (BUILTIN_NAMES.has(tool.name)) {
            console.warn(`MCP: skipping tool "${tool.name}" (collides with builtin)`);
            continue;
          }

          const spec = {
            serverName,
            originalName: tool.originalName,
            prefixedName: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema,
            resourceUri: tool.resourceUri,
          };

          pi.registerTool({
            name: tool.name,
            label: `MCP: ${tool.originalName}`,
            description: tool.description || "(no description)",
            promptSnippet: truncateAtWord(tool.description, 100) || `MCP tool from ${serverName}`,
            parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema || { type: "object", properties: {} }) as any,
            execute: createDirectToolExecutor(() => state, () => initPromise, spec),
          });

          // Determine if this tool is direct (bypassed ToolSearch)
          if (earlyDirectToolNames.has(tool.name)) {
            directToolNames.push(tool.name);
          }
        }
      }

      // 3. Store direct tool names in state for ToolSearch to filter against
      state.directToolNames = directToolNames;

      // 4. Register ToolSearch (always active — the LLM uses it to discover deferred tools)
      pi.registerTool(createToolSearchTool(() => state, pi));

      // 5. Narrow active set: only builtins + ToolSearch + direct tools
      // (builtinActive may include early-registered direct tools; Set dedup handles it)
      const activeNames = [
        ...builtinActive,
        "ToolSearch",
        ...directToolNames,
      ];
      pi.setActiveTools([...new Set(activeNames)]);

      // 6. Override reconnect callback to also re-register ToolSearch with fresh catalog
      s.lifecycle.setReconnectCallback((serverName) => {
        updateServerMetadata(s, serverName);
        updateMetadataCache(s, serverName);
        s.failureTracker.delete(serverName);
        updateStatusBar(s);

        // Re-register ToolSearch so the LLM sees an updated catalog with new/refreshed tools
        pi.registerTool(createToolSearchTool(() => s, pi));
      });
    }).catch(() => {
      initPromise = null;
    });
  });

  // --- turn_end keep-alive hook: reconnect disconnected keep-alive/eager servers ---
  pi.on("turn_end", async () => {
    if (!state) return;
    for (const [serverName, definition] of Object.entries(state.config.mcpServers)) {
      if (definition.enabled === false) continue;
      // Only auto-reconnect servers that are meant to stay connected
      const mode = definition.lifecycle ?? "lazy";
      if (mode !== "keep-alive" && mode !== "eager") continue;
      const connection = state.manager.getConnection(serverName);
      if (!connection || connection.status !== "connected") {
        try {
          await lazyConnect(state, serverName);
        } catch {
          // Reconnect failures handled by lazyConnect with backoff
        }
      }
    }
  });

  // --- /mcp command (unchanged) ---
  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
          return;
        }
      }

      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          await showStatus(state, ctx);
          break;
      }
    },
  });
}
