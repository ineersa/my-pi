# ToolSearch Rewrite Plan

## The Problem

Current proxy mode = single `mcp` mega-tool with generic `{tool?, args?, search?, ...}` schema.
LLMs can't use it because:
- They don't know what tools exist (names hidden behind a search call)
- They can't generate correct JSON args (no typed schema, just `Record<string,unknown>`)
- It takes 2-3 turns to discover → describe → call

## The Solution

**OpenAI-style client-side ToolSearch**, adapted for Pi's API.

```
┌─────────────────────────────────────────────────────────┐
│  STARTUP                                                │
│                                                         │
│  1. Load config + metadata cache (already done)         │
│  2. For every MCP tool from cache:                      │
│     registerTool({ name, description, parameters })     │
│     ↑ FULL schema from cache, real execute function     │
│  3. Register a "ToolSearch" tool (always active)        │
│  4. setActiveTools([ ...builtins, "ToolSearch" ])       │
│     ↑ MCP tools are registered but NOT active           │
│  5. Inject system reminder with deferred tool catalog   │
│                                                         │
│  LLM sees:                                              │
│  - Built-in tools (read, bash, edit, ...)              │
│  - ToolSearch tool                                      │
│  - System reminder: "MCP tools: server_tool (desc)"     │
│  - NO MCP tool schemas (saves ~2000+ tokens/turn)       │
├─────────────────────────────────────────────────────────┤
│  TURN 1: LLM NEEDS AN MCP TOOL                         │
│                                                         │
│  LLM: ToolSearch({ query: "jetbrains find definition" })│
│                                                         │
│  ToolSearch searches deferred pool, finds matches:      │
│  - Returns: tool names + descriptions + FULL schemas    │
│  - Calls setActiveTools([...previous, "found_tool"])    │
│  - Returns: "Loaded: server_tool. You can now call it." │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  TURN 2: TOOL IS NOW ACTIVE                             │
│                                                         │
│  LLM sees server_tool with full typed schema            │
│  LLM calls: server_tool({ param: "value" })            │
│  execute() lazy-connects to server, calls the tool      │
│  Result returned normally                               │
│                                                         │
│  Tool stays active for rest of session                  │
└─────────────────────────────────────────────────────────┘
```

## Files to Change

### 1. NEW: `tool-search.ts` — The ToolSearch tool

Replace the proxy tool. This is the only tool the LLM sees for MCP initially.

```typescript
// tool-search.ts

export function createToolSearchTool(
  state: McpExtensionState,
  pi: ExtensionAPI,
) {
  return {
    name: "ToolSearch",
    label: "MCP ToolSearch",
    description: buildToolSearchDescription(state),
    promptSnippet: "Search and load MCP tools on demand",
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query. Use "select:name1,name2" to load exact tools, or keywords like "jetbrains search symbol"'
      }),
    }),
    async execute(toolCallId: string, params: { query: string }) {
      const { query } = params;
      const deferredTools = getAllDeferredTools(state);

      // Parse select: prefix
      const selectMatch = query.match(/^select:(.+)$/i);
      if (selectMatch) {
        const names = selectMatch[1].split(",").map(s => s.trim());
        return loadAndActivate(state, pi, names, deferredTools);
      }

      // Keyword search
      const matches = searchByKeywords(query, deferredTools);
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No MCP tools matching "${query}". Available servers: ${listServerNames(state)}` }],
        };
      }

      return loadAndActivate(state, pi, matches.map(m => m.name), deferredTools);
    },
  };
}
```

**Key behavior of `loadAndActivate`:**

```typescript
function loadAndActivate(
  state: McpExtensionState,
  pi: ExtensionAPI,
  toolNames: string[],
  deferredTools: DeferredTool[],
): AgentToolResult {
  const found: DeferredTool[] = [];
  const notFound: string[] = [];

  for (const name of toolNames) {
    const tool = deferredTools.find(
      t => t.name === name || t.originalName === name
    );
    if (tool) found.push(tool);
    else notFound.push(name);
  }

  if (found.length === 0) {
    return {
      content: [{ type: "text", text: `No tools found for: ${toolNames.join(", ")}. Use ToolSearch with keywords to search.` }],
    };
  }

  // Activate found tools
  const currentActive = pi.getActiveTools();
  const toActivate = found.map(t => t.name);
  const newActive = [...new Set([...currentActive, ...toActivate])];
  pi.setActiveTools(newActive);

  // Build response with full schemas so LLM sees them in the tool result
  let text = `Loaded ${found.length} MCP tool${found.length > 1 ? "s" : ""}:\n\n`;
  for (const tool of found) {
    text += `## ${tool.name}\n${tool.description}\n`;
    if (tool.inputSchema) {
      text += `\nParameters:\n${formatSchema(tool.inputSchema, "  ")}\n`;
    }
    text += `\nYou can now call ${tool.name}(params) directly.\n\n`;
  }

  if (notFound.length > 0) {
    text += `Not found: ${notFound.join(", ")}\n`;
  }

  return {
    content: [{ type: "text", text: text.trim() }],
    details: { loaded: found.map(t => t.name), notFound },
  };
}
```

### 2. REWRITE: `pi-mcp-adapter.ts` — Registration logic

```typescript
// In the main extension function, replace the proxy tool registration:

// Step 1: Register ALL MCP tools (from cache) with full schemas + execute
// Partition into direct (always active) and deferred (need ToolSearch)
const directToolNames: string[] = [];

for (const spec of allToolSpecs) {
  pi.registerTool({
    name: spec.prefixedName,
    label: `MCP: ${spec.originalName}`,
    description: spec.description || "(no description)",
    parameters: Type.Unsafe(spec.inputSchema || { type: "object", properties: {} }),
    execute: createDirectToolExecutor(() => state, () => initPromise, spec),
  });

  // Direct tools are always active — no ToolSearch needed
  if (isDirectTool(spec, config)) {
    directToolNames.push(spec.prefixedName);
  }
}

// Step 2: Register ToolSearch (always active)
pi.registerTool(createToolSearchTool(stateGetter, pi));

// Step 3: Set active tools = builtins + ToolSearch + direct tools
// Deferred MCP tools are registered but NOT active
pi.setActiveTools([
  ...pi.getActiveTools(),  // builtins
  "ToolSearch",
  ...directToolNames,
]);
```

**`isDirectTool` logic** (reuses existing `resolveDirectTools` from `direct-tools.ts`):
- Per-server: `definition.directTools === true` → all tools from that server are direct
- Per-server: `definition.directTools === ["tool1", "tool2"]` → only listed tools are direct
- Global: `config.settings?.directTools === true` → all tools from all servers are direct
- Env override: `MCP_DIRECT_TOOLS=server1,server2/toolname` → same as before
- Anything not matching → deferred (needs ToolSearch)

### 3. REWRITE: ToolSearch description — the "catalog"

This is what the LLM sees in the ToolSearch tool description. It's the replacement for the `<available-deferred-tools>` block.

```typescript
function buildToolSearchDescription(state: McpExtensionState): string {
  let desc = `Discover and load MCP tools on demand.

You search for tools by name or description. Matching tools are activated with their full parameter schemas, then you can call them directly.

## Available MCP tools:

`;

  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    const status = getServerStatus(state, serverName);
    if (status === "disabled") continue;

    desc += `### ${serverName}${status !== "connected" ? ` (${status})` : ""}\n`;
    for (const tool of metadata) {
      const shortDesc = (tool.description || "").split("\n")[0].slice(0, 100);
      desc += `- ${tool.name}: ${shortDesc}\n`;
    }
    desc += "\n";
  }

  desc += `## Usage:
- ToolSearch({ query: "keywords" }) — search by keywords, loads matches
- ToolSearch({ query: "select:server_toolname" }) — load specific tools by name

After loading, call tools directly with their typed parameters.`;

  return desc;
}
```

**Token cost estimate with your 70 tools:**
- Names + one-line descriptions ≈ 2000 tokens in ToolSearch description
- This is sent once (ToolSearch description is cached in the tool definition)
- Compare to direct mode: 70 full schemas ≈ 8000+ tokens every turn

### 4. MODIFY: `init.ts` — Update tool description after connections

After servers connect and metadata refreshes, update ToolSearch description:

```typescript
// After connecting servers and updating toolMetadata:
lifecycle.setReconnectCallback((serverName) => {
  updateServerMetadata(state, serverName);
  updateMetadataCache(state, serverName);

  // Re-register ToolSearch with updated catalog
  pi.registerTool(createToolSearchTool(() => state, pi));
  pi.refreshTools(); // picks up the new description

  // Re-activate: ToolSearch + previously discovered tools + new tools
  const discovered = getDiscoveredToolNames();
  pi.setActiveTools([...pi.getActiveTools(), ...discovered]);
});
```

### 5. REMOVE: Proxy mode code

Delete or gut these from `proxy-modes.ts`:
- `executeStatus`, `executeList`, `executeDescribe`, `executeConnect` — all replaced by ToolSearch
- `executeSearch` — replaced by ToolSearch's search
- `executeCall` — replaced by direct tool execute (already exists in direct-tools.ts)

Keep `executeStatus` for the `/mcp` command only (UI status display).

### 6. KEEP: `direct-tools.ts` — `createDirectToolExecutor`

This is already correct. Each registered MCP tool uses this executor. It:
- Lazy-connects on first call
- Calls the real MCP tool
- Returns results

No changes needed here.

## Session Lifecycle

```
session_start:
  1. Load config + cache
  2. registerTool() for each MCP tool from cache (full schema, direct execute)
  3. registerTool("ToolSearch", ...) with catalog description
  4. setActiveTools([...builtins, "ToolSearch"])
  5. Connect keep-alive/eager servers in background
  6. On connect → update metadata → re-register ToolSearch with fresh catalog

Each turn:
  LLM sees: builtins + ToolSearch (+ any previously discovered MCP tools)
  LLM calls ToolSearch("slack send")
  → ToolSearch finds matches, setActiveTools([... + new tools])
  → Returns full schemas in text
  Next turn: LLM calls the MCP tool directly with typed params

session_end:
  flushMetadataCache(state)
  lifecycle.gracefulShutdown()
```

## Edge Cases

### Server not connected when tool is called
`createDirectToolExecutor` already handles this — lazy-connects, returns error if unreachable. No change needed.

### ToolSearch returns a tool whose server is down
The tool gets activated. When LLM calls it, `createDirectToolExecutor` tries to connect, fails, returns error with schema so LLM can retry later.

### Many tools from one server
ToolSearch supports `select:` for exact loading and keyword search. After first discovery, tools stay active.

### Cold start (no cache)
First session: ToolSearch description shows "(not connected, cached)" for servers. After eager servers connect, description updates. LLM can still search cached metadata.

### Compaction / session resume
Discovered tools should be re-activated on resume. Track discovered names in session state or re-derive from message history.

## What Gets Deleted

| File | What to remove |
|------|---------------|
| `pi-mcp-adapter.ts` | Proxy tool registration (`pi.registerTool({ name: "mcp", ... })`), the big `execute()` function |
| `proxy-modes.ts` | `executeCall`, `executeSearch`, `executeDescribe`, `executeList`, `executeConnect`. Keep `executeStatus` for `/mcp` command |

## What Stays Unchanged

| File | Why |
|------|-----|
| `direct-tools.ts` | `createDirectToolExecutor` is THE execution path for both direct and deferred tools. `buildProxyDescription()` kept for backward compat. `resolveDirectTools()` used to determine which tools bypass ToolSearch |
| `toon-encoder.ts` | Toon encoding in tool results still useful |

## What Gets Added

| File | What it does |
|------|-------------|
| `tool-search.ts` (NEW) | ToolSearch tool: search deferred tools, activate matches, return schemas |

## Tool Modes Summary

| Mode | Config | Tool visibility | Registration |
|------|--------|----------------|--------------|
| **Direct** | `directTools: true` or `directTools: ["tool1"]` per server, or global, or `MCP_DIRECT_TOOLS` env | Registered + **active** from session start. Full schema always in prompt. | Bypasses ToolSearch entirely |
| **Deferred** | Everything else (default) | Registered but **inactive**. LLM discovers via ToolSearch. After discovery: activated with full schema. | Needs ToolSearch round-trip |

Direct tools consume more tokens but are more reliable — no discovery step, schema always visible.
Deferred tools save tokens but require ToolSearch before first use.



## Implementation Order

1. **Create `tool-search.ts`** — ToolSearch tool with search + activate logic
2. **Rewrite `pi-mcp-adapter.ts`** — Register all tools inactive, register ToolSearch active
3. **Trim `proxy-modes.ts`** — Keep only `executeStatus` for the `/mcp` command
4. **Test** — Verify ToolSearch discovers, activates, and tools are callable next turn
5. **Handle reconnection** — Re-register ToolSearch after server connects/reconnects
