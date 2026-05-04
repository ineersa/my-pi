import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { ServerEntry, ToolMetadata } from "./types.js";
import { existsSync } from "node:fs";
import { loadMcpConfig } from "./config.js";
import { McpLifecycleManager } from "./lifecycle.js";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.js";
import { McpServerManager } from "./server-manager.js";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.js";
import { parallelLimit } from "./utils.js";
import { logger } from "./logger.js";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.js";
import { createStatsTracker } from "./stats.js";

const FAILURE_BACKOFF_MS = 60 * 1000;

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<McpExtensionState> {
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const config = loadMcpConfig(configPath);

  const manager = new McpServerManager();
  const lifecycle = new McpLifecycleManager(manager);
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const failureTracker = new Map<string, number>();
  const statsTracker = createStatsTracker(config, ctx.cwd);
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const state: McpExtensionState = {
    manager,
    lifecycle,
    toolMetadata,
    config,
    failureTracker,
    statsTracker,
    ui,
    directToolNames: [],
  };

  const serverEntries = Object.entries(config.mcpServers)
    .filter(([, definition]) => definition.enabled !== false);
  if (serverEntries.length === 0) {
    return state;
  }

  const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
  lifecycle.setGlobalIdleTimeout(idleSetting);

  const cachePath = getMetadataCachePath();
  const cacheFileExists = existsSync(cachePath);
  let cache = loadMetadataCache();
  let bootstrapAll = false;

  if (!cacheFileExists) {
    bootstrapAll = true;
    saveMetadataCache({ version: 1, servers: {} });
  } else if (!cache) {
    cache = { version: 1, servers: {} };
    saveMetadataCache(cache);
  }

  const prefix = config.settings?.toolPrefix ?? "server";

  for (const [name, definition] of serverEntries) {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const idleOverride = definition.idleTimeout ?? (lifecycleMode === "eager" ? 0 : undefined);
    lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
    );
    if (lifecycleMode === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }

    if (cache?.servers?.[name] && isServerCacheValid(cache.servers[name], definition)) {
      const metadata = reconstructToolMetadata(name, cache.servers[name], prefix, definition);
      toolMetadata.set(name, metadata);
    }
  }

  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ctx.hasUI && startupServers.length > 0) {
    ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
  }

  const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
  let anyTimedOut = false;

  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    const timeoutMs = definition.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    const connectPromise = manager.connect(name, definition).then(connection => {
      if (connection.status === "needs-auth") {
        return { name, definition, connection: null, error: `Server requires auth (disabled in this build): ${name}` };
      }
      return { name, definition, connection, error: null };
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    });

    const timeoutPromise = new Promise<{ name: string; definition: ServerEntry; connection: null; error: string }>(
      resolve => setTimeout(() => {
        resolve({ name, definition, connection: null, error: "Connection timed out" });
      }, timeoutMs)
    );

    const result = await Promise.race([connectPromise, timeoutPromise]);
    if (result.error === "Connection timed out") {
      anyTimedOut = true;
    }
    return result;
  });

  if (anyTimedOut && ctx.hasUI) {
    ctx.ui.notify("MCP: One or more server connections timed out during startup", "warning");
  }

  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${name}: ${error}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${error}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    updateMetadataCache(state, name);

    if (failedTools.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ctx.hasUI && connectedCount > 0) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }

  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache();
    const missingCacheServers = getMissingConfiguredDirectToolServers(config, currentCache);

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          const definition = config.mcpServers[name];
          try {
            const connection = await manager.connect(name, definition);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
            toolMetadata.set(name, metadata);
            updateMetadataCache(state, name);
            return { name, ok: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`MCP: direct-tools bootstrap failed for ${name}: ${message}`);
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter(r => r.ok).map(r => r.name);
      if (bootstrapped.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`MCP: direct tools for ${bootstrapped.join(", ")} will be available after restart`, "info");
      }
    }
  }

  lifecycle.setReconnectCallback((serverName) => {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  lifecycle.startHealthChecks();

  return state;
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
}

export function updateMetadataCache(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

export function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.values(state.config.mcpServers).filter(def => def.enabled !== false).length;
  if (total === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = state.manager.getAllConnections().size;
  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

export async function lazyConnect(state: McpExtensionState, serverName: string): Promise<boolean> {
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return false;
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition || definition.enabled === false) return false;

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    const newConnection = await state.manager.connect(serverName, definition);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    state.failureTracker.delete(serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${message}`);
    updateStatusBar(state);
    return false;
  }
}

function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition || definition.enabled === false) {
    return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
  }
  if (typeof definition.idleTimeout === "number") return definition.idleTimeout;
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}
