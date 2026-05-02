# Pass 1: Foundation

Goal: solid naming + search foundations. ToolSearch is built and verifiable standalone before wiring into the adapter.

## Tasks

### 1.1 Update `types.ts` — `__` separator

**File:** `packages/extensions/extensions/pi-mcp-adapter/types.ts`

- `formatToolName()`: change separator from `_` to `__`
  - `p ? \`${p}_${toolName}\` : toolName` → `p ? \`${p}__${toolName}\` : toolName`
- `normalizeToolName()`: ensure it doesn't collapse `__` — only replace `-` with `_`
  - Current: `value.replace(/-/g, "_")` — this is fine, no change needed (doesn't touch `__`)
- Verify all callers of `formatToolName` still work (metadata-cache.ts, tool-metadata.ts, direct-tools.ts, proxy-modes.ts)

### 1.2 Create `tool-search.ts` — ToolSearch tool

**File:** `packages/extensions/extensions/pi-mcp-adapter/tool-search.ts` (NEW)

Create the full ToolSearch tool, but don't wire it into `pi-mcp-adapter.ts` yet. Export functions for testing/verification.

Implement:
- `createToolSearchTool(getState, pi)` — returns ToolDefinition
- `searchByKeywords(query, deferredTools)` — weighted scoring algorithm
- `parseToolNameParts(name)` — splits on `__` for server/tool separator
- `loadAndActivate(pi, toolNames, deferredTools)` — activates tools via `setActiveTools`
- `getAllDeferredTools(state)` — filters out direct tools
- `buildToolSearchDescription(state)` — catalog for tool description

Verify: write a quick smoke test (can be a separate test file or manual verification):
- `searchByKeywords("jetbrains find definition", tools)` returns correct results
- `select:` exact match works
- `loadAndActivate` correctly calls `setActiveTools` with the right names
- Catalog description renders correctly with current metadata

### 1.3 Update `init.ts` — wait for eager servers + reconnect + turn_end

**File:** `packages/extensions/extensions/pi-mcp-adapter/init.ts`

- After initializing MCP lifecycle, wait for eager/keep-alive servers to connect before resolving
  - Add timeout so startup isn't blocked indefinitely
  - On success: metadata cache is populated
- `setReconnectCallback`: when a server reconnects, update metadata + re-register ToolSearch with fresh catalog
- Register `turn_end` hook: check connection health, reconnect disconnected servers
  - Note: this hook registration should go in `pi-mcp-adapter.ts` since that's where `pi` events are wired

### 1.4 Validate foundation

Before moving to Pass 2:
- `formatToolName("find_definition", "jetbrains-index", "server")` → `"jetbrains_index__find_definition"`
- `parseToolNameParts("jetbrains_index__find_definition")` → `["ide", "find", "definition"]` (server prefix stripped)
- ToolSearch can be registered and its `execute` function works standalone
- Catalog description shows tools with `__` separator names
