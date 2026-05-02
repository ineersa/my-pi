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
│                                                         │
│  LLM sees:                                              │
│  - Built-in tools (read, bash, edit, ...)              │
│  - ToolSearch tool (catalog in description)             │
│  - NO MCP tool schemas (saves ~2000+ tokens/turn)       │
├─────────────────────────────────────────────────────────┤
│  TURN 1: LLM NEEDS AN MCP TOOL                         │
│                                                         │
│  LLM: ToolSearch({ query: "jetbrains find definition" })│
│                                                         │
│  ToolSearch searches deferred pool, finds matches:      │
│  - Returns: tool names + short descriptions (no schemas)│
│  - Calls setActiveTools([...previous, "found_tool"])    │
│  - Returns: "Loaded: 3 tools. Call next turn."         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  TURN 2: TOOL IS NOW ACTIVE                             │
│                                                         │
│  LLM sees server_tool with full typed schema            │
│  LLM calls: server__toolname({ param: "value" })         │
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
  getState: () => McpExtensionState,
  pi: ExtensionAPI,
) {
  const state = getState();
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
      const currentState = getState();
      const { query } = params;
      const deferredTools = getAllDeferredTools(currentState);

      // Parse select: prefix
      const selectMatch = query.match(/^select:(.+)$/i);
      if (selectMatch) {
        const names = selectMatch[1].split(",").map(s => s.trim());
        return loadAndActivate(pi, names, deferredTools);
      }

      // Keyword search
      const matches = searchByKeywords(query, deferredTools);
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No MCP tools matching "${query}".` }],
        };
      }

      return loadAndActivate(pi, matches.map(m => m.name), deferredTools);
    },
  };
}
```

**`searchByKeywords` — replicated from Claude Code's weighted scoring:**

```typescript
// Scoring weights per search term (claude-code values, adapted for server_toolname format)
const SCORES = {
  exactPartMatch: 10,        // term === part in tool name
  subPartMatch: 5,           // part includes term (e.g., "def" in "definition")
  fullNameContains: 3,        // fallback: full name contains term
  descriptionMatch: 4,        // word-boundary match in description (acts as "hint")
};
const MAX_RESULTS = 5;

interface DeferredTool {
  name: string;              // server_toolname
  originalName: string;       // original MCP tool name
  description: string;
  serverName: string;
  inputSchema?: object;
}

function searchByKeywords(query: string, deferredTools: DeferredTool[]): DeferredTool[] {
  const queryLower = query.toLowerCase().trim();

  // Fast path: exact tool name match (case-insensitive)
  const exactMatch = deferredTools.find(
    t => t.name.toLowerCase() === queryLower || t.originalName.toLowerCase() === queryLower
  );
  if (exactMatch) return [exactMatch];

  // Tokenize query into terms
  const terms = queryLower.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  // Compile word-boundary patterns for description matching
  const termPatterns = new Map<string, RegExp>();
  for (const term of terms) {
    termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
  }

  // Score each deferred tool
  const scored: Array<{ tool: DeferredTool; score: number }> = [];
  for (const tool of deferredTools) {
    let score = 0;
    const nameParts = parseToolNameParts(tool.name);
    const descriptionLower = (tool.description || "").toLowerCase();

    for (const term of terms) {
      // Name match: exact part
      if (nameParts.includes(term)) {
        score += SCORES.exactPartMatch;
        continue;
      }
      // Name match: sub-part
      if (nameParts.some(p => p.includes(term))) {
        score += SCORES.subPartMatch;
        continue;
      }
      // Name match: full name contains (fallback)
      if (tool.name.toLowerCase().includes(term)) {
        score += SCORES.fullNameContains;
        continue;
      }
      // Description word-boundary match
      const pattern = termPatterns.get(term)!;
      if (pattern.test(descriptionLower)) {
        score += SCORES.descriptionMatch;
      }
    }

    if (score > 0) scored.push({ tool, score });
  }

  // Sort descending by score, cap at MAX_RESULTS
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map(s => s.tool);
}

/** Parse tool name into lowercase parts using __ as server/tool separator:
 *  "jetbrains-index__ide_find_definition" → ["jetbrains", "index", "ide", "find", "definition"] */
function parseToolNameParts(name: string): string[] {
  const lower = name.toLowerCase();
  // Split on __ to get [serverPrefix, toolName]
  const parts = lower.split("__");
  const toolPart = parts.length > 1 ? parts.slice(1).join("__") : parts[0];
  return toolPart.split("_").filter(p => p.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

**Key design decisions vs Claude Code:**
- Skipped `+required` prefix (simpler query model; LLMs handle this via tool description / system reminder)
- Skipped `mcp__` prefix fast-path (our tool names use `server_toolname`, not `mcp__server__action`)
- Skipped `searchHint` field (we use description as the primary text-match surface)
- Skipped MCP +2 score bonus on part matches (simpler; no MCP-specific tool name handling needed)

**Key behavior of `loadAndActivate`:**

```typescript
function loadAndActivate(
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
  // getActiveTools() returns objects; setActiveTools() expects string[]
  const currentActive = pi.getActiveTools().map(t => t.name);
  const toActivate = found.map(t => t.name);
  const newActive = [...new Set([...currentActive, ...toActivate])];
  pi.setActiveTools(newActive);

  // Build response: names + descriptions only (2-turn pattern).
  // Schemas are NOT dumped — the LLM sees typed parameters next turn
  // when they appear in the active tool list for the next API request.
  let text = `Loaded ${found.length} MCP tool${found.length > 1 ? "s" : ""}. You can call them next turn with typed parameters:\n\n`;
  for (const tool of found) {
    const shortDesc = (tool.description || "").split("\n")[0].slice(0, 120);
    text += `- **${tool.name}**: ${shortDesc}\n`;
  }

  if (notFound.length > 0) {
    text += `\nNot found: ${notFound.join(", ")}\n`;
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

// Step 0: Capture built-in active tools BEFORE any registerTool calls.
// registerTool auto-adds to the active set, so we must snapshot first
// to avoid re-adding deferred tools in the final setActiveTools call.
const builtinActive = pi.getActiveTools();

// Step 1: Register ALL MCP tools (from cache) with full schemas + execute
// registerTool auto-activates each tool, so they temporarily enter the active set.
// We narrow them back down in Step 3.
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

// Step 3: Set active tools = builtins (captured before registration) + ToolSearch + direct tools
// Deferred MCP tools were auto-activated by registerTool but are now excluded.
pi.setActiveTools([
  ...builtinActive,  // captured BEFORE MCP tool registration, so only builtins
  "ToolSearch",
  ...directToolNames,
]);
```

**`isDirectTool` logic:**
- Per-server: `definition.directTools === true` → all tools from that server are direct
- Per-server: `definition.directTools === ["tool1", "tool2"]` → only listed tools are direct
- Env override: `MCP_DIRECT_TOOLS=server1,server2/toolname` → same as before
- Anything not matching → deferred (needs ToolSearch)

Removed settings (no longer applicable):
- Global `directTools` — was `config.settings?.directTools`. Replaced by per-server config.
- `disableProxyTool` — the `mcp` proxy tool is gone, nothing to disable.

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

  // Re-register ToolSearch with updated catalog (registerTool auto-calls refreshTools)
  pi.registerTool(createToolSearchTool(() => state, pi));

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
  2. Initialize MCP lifecycle (connect eager/keep-alive servers, fetch metadata)
  3. Wait for eager servers to connect (with timeout) so cache is populated
  4. Capture builtinActive = pi.getActiveTools() (BEFORE any registerTool)
  5. registerTool() for each MCP tool from cache (full schema, direct execute)
     ↑ registerTool auto-activates each tool temporarily
  6. registerTool("ToolSearch", ...) with catalog description (now populated)
  7. setActiveTools([...builtinActive, "ToolSearch", ...directToolNames])
     ↑ narrows back down: only builtins + ToolSearch + direct tools are active
  8. On reconnect → update metadata → re-register ToolSearch with fresh catalog

Each turn:
  LLM sees: builtins + ToolSearch (+ any previously discovered MCP tools)
  LLM calls ToolSearch("jetbrains find definition")
  → ToolSearch finds matches, setActiveTools([... + new tools])
  → Returns tool names + short descriptions (no schemas)
  Next turn: LLM calls the MCP tool directly with typed params
  After turn: turn_end hook checks connection health, reconnects if needed

session_end:
  flushMetadataCache(state)
  lifecycle.gracefulShutdown()
```

## Edge Cases

### Compaction / session resume

Track discovered tool names in a `Set<string>` in the extension's closure (survives compaction within session, resets on `session_start`). On resume, re-apply: `pi.setActiveTools([...builtins, "ToolSearch", ...directTools, ...discovered])`.

```typescript
let discoveredToolNames = new Set<string>();

// In loadAndActivate:
discoveredToolNames = new Set([...discoveredToolNames, ...found.map(t => t.name)]);

// On session_start:
discoveredToolNames = new Set(); // reset for new session
```

### Server not connected when tool is called
`createDirectToolExecutor` already handles this — lazy-connects, returns error if unreachable. No change needed.

### ToolSearch returns a tool whose server is down
The tool gets activated. When LLM calls it, `createDirectToolExecutor` tries to connect, fails, returns error with schema so LLM can retry later.

### Many tools from one server
ToolSearch supports `select:` for exact loading and keyword search. After first discovery, tools stay active.

### Cold start (no cache)
Eager servers are connected and metadata fetched BEFORE ToolSearch is registered. ToolSearch catalog is always populated from the start, even on a cold cache. Non-eager servers show as "(not connected)" but their tools are still listed from cache (if available) or omitted entirely.

## What Gets Deleted

| File | What to remove |
|------|---------------|
| `pi-mcp-adapter.ts` | The old `mcp` proxy tool (`pi.registerTool({ name: "mcp", ... })`), the big `execute()` function, `shouldRegisterProxyTool` logic, `getPiTools` helper, `missingConfiguredDirectToolServers` logic |
| `proxy-modes.ts` | `executeCall`, `executeSearch`, `executeDescribe`, `executeList`, `executeConnect`. Keep `executeStatus` for `/mcp` command |
| `types.ts` / config | Global `directTools` setting (`config.settings?.directTools`), `disableProxyTool` setting |

## What Stays Unchanged (Mostly)

| File | Why |
|------|-----|
| `direct-tools.ts` | `createDirectToolExecutor` is THE execution path for both direct and deferred tools. `resolveDirectTools()` used to determine which tools bypass ToolSearch. `buildProxyDescription()` removed (was for the old `mcp` tool description). |
| `toon-encoder.ts` | Toon encoding in tool results still useful |

## What Gets Tweaked

| File | Change |
|------|--------|
| `types.ts` `formatToolName()` | Change separator from `_` to `__`: `p ? \`${p}__${toolName}\` : toolName`. This prevents ambiguity when server names contain underscores (e.g., `my_server__toolname` is unambiguous). Also update `parseToolNameParts()` accordingly — split on `__` to get server prefix, then split the rest on `_` for name parts. |
| `types.ts` `normalizeToolName()` | Ensure it doesn't collapse double underscores: only replace `-` with `_`.

## What Gets Added

| File | What it does |
|------|-------------|
| `tool-search.ts` (NEW) | ToolSearch tool: search deferred tools, activate matches, return schemas |

**Implementation notes for `tool-search.ts`:**

```typescript
// getAllDeferredTools: all registered MCP tools that are NOT direct
function getAllDeferredTools(state: McpExtensionState): DeferredTool[] {
  const directNames = new Set(state.directToolNames);
  const deferred: DeferredTool[] = [];
  for (const [serverName, tools] of state.toolMetadata.entries()) {
    for (const tool of tools) {
      const prefixed = formatToolName(tool.name, serverName, state.config.settings?.toolPrefix ?? "server");
      if (!directNames.has(prefixed)) {
        deferred.push({
          name: prefixed,
          originalName: tool.name,
          description: tool.description || "",
          serverName,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }
  return deferred;
}
```

**`turn_end` keep-alive hook (in `pi-mcp-adapter.ts`):**

```typescript
pi.on("turn_end", async () => {
  if (!state) return;
  for (const [serverName, serverState] of state.lifecycle.getAllServers()) {
    if (serverState.status === "disconnected") {
      await state.lifecycle.reconnect(serverName);
    }
  }
});
```

## Tool Modes Summary

| Mode | Config | Tool visibility | Registration |
|------|--------|----------------|--------------|
| **Direct** | `directTools: true` or `directTools: ["tool1"]` per server, or `MCP_DIRECT_TOOLS` env | Registered + **active** from session start. Full schema always in prompt. | Bypasses ToolSearch entirely |
| **Deferred** | Everything else (default) | Registered but **inactive**. LLM discovers via ToolSearch. After discovery: activated with full schema. | Needs ToolSearch round-trip |

Direct tools consume more tokens but are more reliable — no discovery step, schema always visible.
Deferred tools save tokens but require ToolSearch before first use.



## Implementation Order

1. **Create `tool-search.ts`** — ToolSearch tool with search + activate logic
2. **Rewrite `pi-mcp-adapter.ts`** — Register all tools inactive, register ToolSearch active
3. **Trim `proxy-modes.ts`** — Keep only `executeStatus` for the `/mcp` command
4. **Test** — Verify ToolSearch discovers, activates, and tools are callable next turn
5. **Handle reconnection** — Re-register ToolSearch after server connects/reconnects
