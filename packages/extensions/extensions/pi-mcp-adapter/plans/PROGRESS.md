# ToolSearch Rewrite — Progress

## Pass 1: Foundation ✅

### 1.1 Update `types.ts` — `__` separator ✅

- `formatToolName()`: changed separator from `_` to `__`
  - `p ? \`${p}_${toolName}\` : toolName` → `p ? \`${p}__${toolName}\` : toolName`
- `normalizeToolName()`: verified no change needed — only replaces `-` with `_`, preserves `__`
- All callers (metadata-cache.ts, tool-metadata.ts, direct-tools.ts) use `formatToolName` and automatically pick up the new separator

### 1.2 Create `tool-search.ts` ✅

New file: `packages/extensions/extensions/pi-mcp-adapter/tool-search.ts`

Exported functions:
- `createToolSearchTool(getState, pi)` — returns ToolDefinition with ToolSearch tool
- `searchByKeywords(query, deferredTools)` — weighted scoring algorithm
- `parseToolNameParts(name)` — splits on `__` for server/tool separator, returns tool name parts
- `loadAndActivate(pi, toolNames, deferredTools)` — activates tools via `setActiveTools`
- `getAllDeferredTools(state)` — filters out direct tools using `state.directToolNames`
- `buildToolSearchDescription(state)` — catalog description for ToolSearch tool (accepts null safely)

Key design decisions (per plan):
- Skipped `+required` prefix (simpler query model)
- Skipped `mcp__` prefix fast-path (tool names use `server_toolname` format)
- Skipped `searchHint` field (description is primary text-match surface)
- Skipped MCP +2 score bonus on part matches

### 1.3 Update `state.ts` and `init.ts` ✅

`state.ts`:
- Added `directToolNames: string[]` field to `McpExtensionState`

`init.ts`:
- Initialized `directToolNames: []` in state creation
- Added `STARTUP_TIMEOUT_MS` (30s) wrapping the `parallelLimit` for server connections
  - Uses `Promise.race` between connection promise and timeout promise
  - Notifies user via UI if timeout fires
- Added `ServerEntry` import for timeout fallback type

### 1.4 Validate foundation ✅

- `formatToolName("find_definition", "jetbrains-index", "server")` → `"jetbrains_index__find_definition"` ✓
- `parseToolNameParts("jetbrains_index__find_definition")` → `["ide", "find", "definition"]` ✓
- `normalizeToolName()` preserves `__` (only replaces `-` with `_`) ✓
- Typecheck passes with zero errors ✓
- Exported functions are standalone-testable ✓

## Pass 2: Integration + Cleanup ✅

### 2.1 Rewrite `pi-mcp-adapter.ts` — registration logic ✅

- Removed `shouldRegisterProxyTool` logic, `getPiTools` helper, `missingConfiguredConfiguredDirectToolServers` logic
- Kept early config/cache loading, direct tool registration, `/mcp` command, `session_start` lifecycle
- Added after `session_start` handler completes:
  1. Capture `builtinActive = pi.getActiveTools()` before MCP tool registration
  2. Register ALL MCP tools from `state.toolMetadata` (both direct and deferred) with full schemas
  3. Builtin collision guard: skip tools whose prefixed name collides with builtins
  4. Determine direct vs deferred via `earlyDirectToolNames` Set (from early resolution)
  5. Register ToolSearch (always active — acts as the catalog/discovery mechanism)
  6. Narrow active set: `[...builtins, "ToolSearch", ...directTools]`
  7. Override reconnect callback to re-register ToolSearch with fresh catalog on reconnect
- Added `turn_end` keep-alive hook: reconnects only keep-alive/eager disconnected servers

### 2.2 Remove old proxy tool registration ✅

- Deleted entire `if (shouldRegisterProxyTool) { pi.registerTool({ name: "mcp", ... }) }` block
- Removed `buildProxyDescription` import (function also removed from direct-tools.ts)
- Removed all proxy-modes function imports (`proxy-modes.ts` deleted in 2.3)

### 2.3 Remove `proxy-modes.ts` entirely ✅

- `executeStatus` had no callers — all exports dead. Deleted the file.

### 2.4 Remove dead settings ✅

`types.ts`:
- Removed `McpSettings.directTools` (global setting) — per-server `directTools` remains
- Removed `McpSettings.disableProxyTool` — proxy tool is gone, nothing to disable

`direct-tools.ts`:
- Removed global `directTools` fallback from `resolveDirectTools()`
- Removed global `directTools` fallback from `getMissingConfiguredDirectToolServers()`
- Removed `buildProxyDescription()` — was only used by the old proxy tool
- Removed `createIsDirectToolCheck()` — was never imported anywhere (dead code)
- Removed `"mcp"` from `BUILTIN_NAMES` — proxy tool no longer exists
- Exported `BUILTIN_NAMES` for use by pi-mcp-adapter.ts collision guard

### 2.5 Review-driven fixes ✅

**Builtin collision guard** — Added `BUILTIN_NAMES.has(tool.name)` check in the deferred registration loop in pi-mcp-adapter.ts, skipping and warning on collision.

**Stale catalog after reconnect** — `state.lifecycle.setReconnectCallback` now re-registers ToolSearch (with fresh catalog) when a server reconnects mid-session. Fixes a plan divergence where the LLM wouldn't see newly available tools after reconnect.

**turn_end respects lifecycle mode** — Only reconnects servers with lifecycle `keep-alive` or `eager`, avoiding pulling in lazy servers that should connect on demand.

**Null guard in tool-search.ts** — `buildToolSearchDescription` now accepts `McpExtensionState | null` and returns a placeholder message instead of crashing via type assertion.

**Stale comment in tool-registrar.ts** — Updated to reflect that tools are individually registered (not via a single proxy tool).

**discoveredToolNames removed** — The tracking Set was only consumed during session_start (when it was always empty). Active tools are sticky across compaction via `setActiveTools`, so the tracking was unnecessary.

### Integration test checklist

- [ ] Start session → ToolSearch is in active tools with populated catalog
- [ ] LLM calls `ToolSearch({ query: "jetbrains find definition" })` → tools loaded, `setActiveTools` called
- [ ] Next turn: LLM sees `jetbrains_index__ide_find_definition` with full typed schema
- [ ] LLM calls `jetbrains_index__ide_find_definition(params)` → executes correctly
- [ ] Direct tools (if any) are active from the start
- [ ] `/mcp status` command still works
- [ ] Cold start (no cache) → eager servers connect before first turn, catalog is populated
