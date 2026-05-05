# pi-mcp-adapter maintenance

Entry: `pi-mcp-adapter.ts`

## Module Map

| Module | Responsibility |
|---|---|
| `pi-mcp-adapter.ts` | Extension entry point. Registers direct tools early, wires ToolSearch + `/mcp` command, manages lifecycle hooks (`session_start`, `turn_end`, state shutdown). |
| `init.ts` | Lifecycle bootstrap. Loads config/cache, connects eager/keep-alive servers in parallel (30s timeout), bootstraps direct-tool servers missing from cache, builds metadata, resolves direct tools from env. |
| `config.ts` | Config loading with 3-tier merge (user → imports → project). Supports import from Cursor, Claude Code/Desktop, Codex, Windsurf, VS Code. Atomic writes with tmp+rename. |
| `state.ts` | `McpExtensionState` interface — holds manager, lifecycle, toolMetadata, config, failureTracker, statsTracker, ui, directToolNames. |
| `types.ts` | Type definitions: `McpConfig`, `ServerEntry`, `McpTool`, `ToolMetadata`, `DirectToolSpec`. Tool name formatting with `__` separator (`formatToolName`), server prefix modes, exclusion logic (`isToolExcluded`). |
| `server-manager.ts` | `McpServerManager` — MCP SDK Client wrapper. Manages stdio/StreamableHTTP/SSE transports, parallel connection promises, tool/resource pagination (cursor-based), needs-auth detection, in-flight tracking, idle detection. |
| `lifecycle.ts` | `McpLifecycleManager` — keep-alive health checks (30s interval), idle timeout, reconnect callbacks, graceful shutdown. |
| `tool-search.ts` | ToolSearch implementation. `createToolSearchTool()` returns the always-active discovery tool. `searchByKeywords()` — weighted scoring (exact 10 / sub 5 / desc 4 / fallback 3). `loadAndActivate()` — calls `setActiveTools`. `buildToolSearchDescription()` — dynamic catalog from current metadata. |
| `direct-tools.ts` | Direct tool resolution (`resolveDirectTools`) from config/env. `createDirectToolExecutor` — factory for the actual execute function (lazy-connects, calls tool, handles errors, records stats). `BUILTIN_NAMES` collision guard. |
| `metadata-cache.ts` | Persistent cache at `~/.pi/agent/mcp-cache.json`. SHA256 config hashing, 7-day TTL, multi-session-safe writes (tmp+rename per PID). `reconstructToolMetadata()` rebuilds from cache. |
| `tool-metadata.ts` | `buildToolMetadata()` — converts MCP tools + resources into `ToolMetadata[]`. `formatSchema()` — human-readable parameter display. Tool counting, search by name. |
| `tool-registrar.ts` | MCP content type transformation (`transformMcpContent`). Maps text/image/audio/resource/resource_link to Pi content blocks. |
| `commands.ts` | `/mcp` command handlers: `showStatus` (server table), `showTools` (flat tool list), `reconnectServers` (single or all). |
| `resource-tools.ts` | `resourceNameToToolName()` — MCP resource name → valid JS identifier (strips special chars, collapses underscores, adds `resource_` prefix if needed). |
| `npx-resolver.ts` | npx binary resolution. Parses `npx` args, resolves actual bin path from npm cache, bypasses the ~143MB npm parent process. Persistent cache at `~/.pi/agent/mcp-npx-cache.json` (24h TTL). Falls back to original `npx` on failure. |
| `toon-encoder.ts` | `maybeEncodeToon()` — optionally encodes JSON tool responses as TOON when shorter. Applied to successful results only. `isToonEnabled()` checks per-server config. |
| `stats.ts` | `McpStatsTracker` — optional per-server/per-tool call counters. Debounced file writes (default 750ms). `createStatsTracker()` parses `settings.captureStats`. |
| `logger.ts` | Singleton `logger` with debug/info/warn/error levels. Child logger support, MCP_UI_DEBUG env var. |

## Key Lifecycle Events

| Event | Trigger | Action |
|---|---|---|
| `module load` | Pi loads extension | Early config/cache load, direct tool registration from cache |
| `session_start` | Session starts | Shutdown prior state, connect eager/keep-alive servers, register all tools, register ToolSearch, narrow active set |
| `turn_end` | Each turn ends | Reconnect disconnected keep-alive/eager servers |
| `session_end` / reload | Session ends | Flush metadata cache, flush stats, graceful shutdown of all connections |

## Tool Registration Flow

1. **Early (module scope):** Config + cache loaded. Direct tools resolved from cache
   and registered immediately via `pi.registerTool()`. Available before session_start.
2. **session_start:** All MCP tools registered with `pi.registerTool()` (full schemas).
   ToolSearch registered (always active). Active set narrowed to builtins + ToolSearch + direct tools.
3. **On ToolSearch call:** Matched tools activated via `pi.setActiveTools()`.
   Stay active for remainder of session.

## TOON Encoding

Applied in `direct-tools.ts` (`createDirectToolExecutor`) after `transformMcpContent`,
only for successful non-error results when `settings.toonEncode` covers the server.
Dependency: `@toon-format/toon`.

## Stats Capture

When `settings.captureStats` is enabled, direct tool executions (`direct-tools.ts`)
append call counters (success/error and error-code buckets) to a debounced project-local
stats file (default `.pi/mcp-tool-stats.json`). Stats flush on shutdown via
`pi-mcp-adapter.ts`.

## Lifecycle Generation Guard

The `lifecycleGeneration` counter in `pi-mcp-adapter.ts` prevents stale async init results
from replacing newer state during rapid `session_start` → `session_start` transitions
(e.g. `/reload`). Each init captures the generation at start and discards the result if
the generation has since been incremented.

## Metadata Cache Safety

Multi-session safe via per-process temp files:

```
~/.pi/agent/mcp-cache.json.{pid}.tmp  →  rename →  ~/.pi/agent/mcp-cache.json
```

Cache invalidation: SHA256 config hash mismatch or age > 7 days → server reconnected fresh.

## npx Resolution

Resolves `npx -y <package>` and `npx -p <package> <bin>` to direct binary paths from
npm's `_npx` cache directory. Cached at `~/.pi/agent/mcp-npx-cache.json` with 24h TTL.
Falls back to original `npx` invocation on resolution failure.

## Debugging

```bash
# Enable MCP debug logging
MCP_UI_DEBUG=1 pi

# Per-server stderr
{
  "mcpServers": {
    "my-server": {
      "command": "npx", "-y", "my-mcp",
      "debug": true
    }
  }
}

# Override config path
pi --mcp-config /path/to/custom-mcp.json
```
