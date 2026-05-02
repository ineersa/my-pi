# Pass 2: Integration + Cleanup

Goal: wire ToolSearch into the adapter, remove the old proxy tool, and clean up dead code.

## Tasks

### 2.1 Rewrite `pi-mcp-adapter.ts` — registration logic

**File:** `packages/extensions/extensions/pi-mcp-adapter/pi-mcp-adapter.ts`

Replace the proxy tool registration with ToolSearch wiring:

1. **Remove** `shouldRegisterProxyTool` logic, `getPiTools` helper, `missingConfiguredDirectToolServers` logic
2. **Keep** early config/cache loading, direct tool registration, `/mcp` command, `session_start` lifecycle
3. **Add** after `session_start` handler completes (when `state` is set):
   ```typescript
   const builtinActive = pi.getActiveTools(); // capture BEFORE registration

   // Register all MCP tools (both direct and deferred)
   const directToolNames: string[] = [];
   for (const spec of allToolSpecs) {
     pi.registerTool({...});
     if (isDirectTool(spec, config)) directToolNames.push(spec.prefixedName);
   }

   // Register ToolSearch
   pi.registerTool(createToolSearchTool(() => state, pi));

   // Narrow active set
   pi.setActiveTools([...builtinActive.map(t => t.name), "ToolSearch", ...directToolNames]);
   ```
4. **Add** `turn_end` hook for keep-alive:
   ```typescript
   pi.on("turn_end", async () => {
     if (!state) return;
     // check + reconnect disconnected servers
   });
   ```
5. **Track** discovered tool names in `let discoveredToolNames = new Set<string>()`

### 2.2 Remove old proxy tool registration

**File:** `packages/extensions/extensions/pi-mcp-adapter/pi-mcp-adapter.ts`

Delete the entire `if (shouldRegisterProxyTool) { pi.registerTool({ name: "mcp", ... }) }` block.

### 2.3 Trim `proxy-modes.ts`

**File:** `packages/extensions/extensions/pi-mcp-adapter/proxy-modes.ts`

Delete:
- `executeCall`
- `executeSearch`
- `executeDescribe`
- `executeList`
- `executeConnect`

Keep:
- `executeStatus` (used by `/mcp` command)

Remove unused imports after deletion.

### 2.4 Remove dead settings

**Files affected:**
- `types.ts` or config types: remove `globalDirectTools` setting support, remove `disableProxyTool` setting
- `pi-mcp-adapter.ts`: remove references to `disableProxyTool`

### 2.5 Integration test

Verify end-to-end:
1. Start session → ToolSearch is in active tools with populated catalog
2. LLM calls `ToolSearch({ query: "jetbrains find definition" })` → tools loaded, `setActiveTools` called
3. Next turn: LLM sees `jetbrains_index__ide_find_definition` with full typed schema
4. LLM calls `jetbrains_index__ide_find_definition(params)` → executes correctly
5. Direct tools (if any) are active from the start
6. `/mcp status` command still works
7. Compaction survives → discovered tools stay active
8. Cold start (no cache) → eager servers connect before first turn, catalog is populated
