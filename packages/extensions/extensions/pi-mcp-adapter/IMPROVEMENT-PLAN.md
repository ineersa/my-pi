# MCP Adapter Improvement Plan

## Current Architecture vs Claude Code

### How pi-mcp-adapter Works Today

```
┌──────────────────────────────────────────────────┐
│              Two Modes of Operation               │
├────────────────────┬─────────────────────────────┤
│   PROXY MODE       │   DIRECT TOOLS MODE          │
│                    │                               │
│   Single "mcp"     │   Individual tools registered │
│   mega-tool        │   via pi.registerTool()       │
│   registered via   │   with full schemas from      │
│   pi.registerTool()│   metadata cache              │
│                    │                               │
│   LLM calls:       │   LLM calls:                  │
│   mcp({tool:"x"})  │   serverName_toolName({...})  │
│                    │                               │
│   Tool discovers,  │   Tool lazy-connects on       │
│   connects, calls  │   first call, then executes   │
│   all inline       │                               │
└────────────────────┴─────────────────────────────┘

Both modes share:
  - Metadata cache (file-based, ~/.pi/agent/mcp-cache.json)
  - Lazy connection (connect on first use, not at startup)
  - Lifecycle manager (keep-alive / eager / lazy modes)
  - Failure backoff (60s cooldown after failed connect)
  - Idle shutdown (10min default)
```

### How Claude Code Works

```
┌──────────────────────────────────────────────────┐
│         Eager Connect + Deferred Discovery        │
│                                                    │
│  STARTUP: connect ALL servers eagerly              │
│     ↓                                              │
│  DISCOVER: fetch tools/resources in parallel       │
│     ↓                                              │
│  DEFER: all MCP tools sent with defer_loading:true │
│     ↓                                              │
│  TOOL_SEARCH: LLM searches deferred tools on-demand│
│     ↓                                              │
│  EXPAND: API/server expands tool_reference→schema  │
│     ↓                                              │
│  CALL: full schema now in context, tool is callable │
└───────────────────────────────────────────────────┘
```

### Key Differences

| Aspect | pi-mcp-adapter | Claude Code |
|--------|---------------|-------------|
| **Connection timing** | Lazy (on first use) or eager/keep-alive | Always eager at startup |
| **Tool exposure** | All-or-nothing per server | Deferred (names only, schemas loaded on demand) |
| **Discovery** | Static cache + connect-time fetch | Connect-time fetch + `ToolListChanged` notifications |
| **Proxy overhead** | Single mega-tool (LLM must call mcp→search→describe→call) | Direct tools via API-native `defer_loading` |
| **Token cost** | Proxy: 1 tool slot + discovery turns; Direct: all schemas always in prompt | Near-zero until tool is actually needed |
| **Tool routing** | String matching + lazy connect | `mcp__server__tool` prefix + connected server lookup |
| **Reconnection** | Health check interval (30s) for keep-alive only | Immediate via `onclose` handler + exponential backoff |
| **Failure mode** | Skip + 60s backoff + user visible error | Skip silently, tools removed from pool, auto-reconnect |
| **Config sources** | User + project + imports | Enterprise + project + user + local + plugin + claude.ai |
| **OAuth/Auth** | Not supported (disabled) | Full OAuth 2.0 + DCR + token refresh + step-up |
| **Process management** | Basic close | SIGINT→SIGTERM→SIGKILL with timeouts |

---

## Improvement Plan

### Phase 1: Smart Connection Strategy (HIGH IMPACT)

**Problem**: Lazy connection means first tool call pays a latency penalty (spawn process + MCP handshake + fetch tools). Eager connection connects everything at startup even if unused.

**Solution**: Replace with a hybrid strategy that connects eagerly for configured servers but doesn't block startup on slow ones.

**Changes in `init.ts`**:
```
1. Connect all servers at startup (like today's eager/keep-alive)
   BUT don't block — fire in background, update state as they come online
2. Report "pending" servers in proxy tool description so LLM knows to wait
3. Keep lazy connect as fallback for servers not yet online
```

**Changes in `server-manager.ts`**:
```
1. Add connection timeout (configurable, default 30s)
2. Add connection state tracking: pending → connected → failed → reconnecting
3. Don't throw on failure — return a FailedConnection object
```

### Phase 2: Progressive Tool Discovery (HIGH IMPACT)

**Problem**: Proxy mode requires 2-3 LLM turns (search → describe → call). Direct mode sends ALL schemas always (token-expensive).

**Solution**: Implement a ToolSearch-style pattern that works with Pi's extension API.

**New file: `tool-discovery.ts`**:

Since Pi doesn't have `defer_loading` / `tool_reference` (that's Anthropic-specific), implement client-side progressive disclosure:

```
Strategy: "Shallow Registration"

1. Register each MCP tool as a Pi tool with:
   - Full name: server_toolName
   - Minimal description: "MCP tool from server. Use describe mode first."
   - No parameter schema (or { type: "object" })
   
2. First call → lazy connect + fetch full schema → return schema to LLM
   "Tool discovered. Full schema: { ... }. Call again with parameters."
   
3. Second call → execute with real parameters
   
Alternative: Enhance the proxy tool to be smarter:
   - Include ALL tool names + one-line descriptions in the proxy tool's description
   - Tool call with schema included in the result on describe
   - Single turn: mcp({ tool: "name" }) → auto-discovers + executes
```

**Recommended approach**: Enhance the proxy tool with better discovery UX:

```
Current (3 turns):
  1. mcp({ search: "slack" })      → list of names
  2. mcp({ describe: "slack_send" }) → schema
  3. mcp({ tool: "slack_send", args: {...} }) → result

Improved (1-2 turns):
  1. mcp({ tool: "slack_send", args: {...} }) 
     → Auto-discovers schema, validates, and executes
     → On schema mismatch: returns schema + "try again with correct params"
     
  2. For unknown tools: 
     mcp({ search: "slack", includeSchemas: true })
     → Returns names + schemas ready to call
```

### Phase 3: Robust Reconnection (MEDIUM IMPACT)

**Problem**: Only keep-alive servers get health checks. Stdio servers that crash silently die. No reconnection with backoff for failed servers.

**Changes in `lifecycle.ts`**:
```
1. Track connection state per server: connected | failed | pending | disabled
2. On connection drop:
   - For remote servers: exponential backoff reconnect (1s → 2s → 4s → 8s → 16s, max 5)
   - For stdio servers: mark failed, surface in /mcp UI, don't auto-reconnect
   - Update tool metadata after successful reconnect
3. On tool call to failed server:
   - If within backoff window: return "server X failed N seconds ago, retry later"
   - If backoff expired: attempt one reconnect, then call
```

**Changes in `server-manager.ts`**:
```
1. Register onclose/onerror handlers on Client
2. Clear tool metadata cache on disconnect
3. Re-fetch tools after reconnect (server may have changed its tool list)
4. Support ToolListChangedNotification / ResourceListChangedNotification
   from the MCP SDK to trigger incremental metadata refresh
```

### Phase 4: Enhanced Error Handling (MEDIUM IMPACT)

**Problem**: Error messages don't help the LLM self-correct. Server failures during calls are fatal to that call.

**Changes in `proxy-modes.ts` and `direct-tools.ts`**:
```
1. On server crash during tool call:
   - Attempt one reconnect + retry
   - If retry fails: return error with available alternatives
   
2. Better error messages:
   - Include the correct parameter schema on validation errors
   - Include server status (connected/failed/reconnecting)
   - Include alternative tool names on typos (fuzzy match)

3. On timeout:
   - Configurable per-server timeout (default 120s)
   - Progress indication for long-running tools
```

### Phase 5: Process Lifecycle Improvements (LOWER IMPACT)

**Changes in `server-manager.ts`**:
```
1. Stderr capture: Capture first N KB of stderr for debugging failed startups
2. Graceful shutdown: SIGINT → 100ms → SIGTERM → 400ms → SIGKILL
3. Child process tracking: Track PIDs, clean up orphans on shutdown
4. Npx resolution: Already done! Keep the npx-resolver.ts approach
```

### Phase 6: Config Layering (LOWER IMPACT)

**Already partially implemented** via imports. Enhance:
```
1. Support .mcp.json in project root (already done via .pi/mcp.json)
2. Environment variable expansion in all string fields (already done)
3. Add server enable/disable without removing config
4. Schema validation with helpful error messages
```

---

## Implementation Priority

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| 🥇 1 | Smart connection strategy | Medium | Eliminates cold-start latency |
| 🥇 2 | Progressive tool discovery | Medium | Reduces turns, saves tokens |
| 🥈 3 | Robust reconnection | Medium | Reliability |
| 🥈 4 | Enhanced error handling | Low | Better LLM self-correction |
| 🥉 5 | Process lifecycle | Low | Debugging, cleanup |
| 🥉 6 | Config layering | Low | Already mostly done |

## Concrete Code Changes

### 1. server-manager.ts — Connection State Machine

```typescript
// Add to ServerConnection
interface ServerConnection {
  // ...existing fields...
  status: "connected" | "closed" | "needs-auth" | "pending" | "failed";
  error?: string;
  connectedAt?: number;
  reconnectAttempt?: number;
}

// Add state change callbacks
class McpServerManager {
  private onStateChange?: (name: string, state: ServerConnection) => void;
  
  // Add connection timeout
  async connect(name: string, definition: ServerDefinition, timeoutMs = 30000): Promise<ServerConnection> {
    // ...existing code...
    
    // Race connection against timeout
    const connection = await Promise.race([
      this.createConnection(name, definition),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
    
    // Register onclose handler for reconnection
    connection.client.onclose = () => {
      connection.status = "closed";
      this.connections.delete(name);
      this.onStateChange?.(name, connection);
    };
    
    return connection;
  }
}
```

### 2. lifecycle.ts — Exponential Backoff Reconnection

```typescript
private async reconnectWithBackoff(
  name: string, 
  definition: ServerDefinition,
  maxAttempts = 5,
): Promise<boolean> {
  const INITIAL_BACKOFF_MS = 1000;
  const MAX_BACKOFF_MS = 30000;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1),
      MAX_BACKOFF_MS
    );
    
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    
    try {
      const connection = await this.manager.connect(name, definition);
      if (connection.status === "connected") {
        this.onReconnect?.(name);
        return true;
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        return false;
      }
    }
  }
  return false;
}
```

### 3. proxy-modes.ts — Auto-Discovery on Call

```typescript
export async function executeCall(state, toolName, args, serverOverride?) {
  // ...existing lookup logic...
  
  // NEW: If tool found but server not connected, auto-connect
  if (serverName && toolMeta && !isConnected(state, serverName)) {
    const connected = await lazyConnect(state, serverName);
    if (!connected) {
      // Return schema so LLM can retry when server comes back
      return {
        content: [{ type: "text", text: 
          `Server "${serverName}" is not available. Tool schema for reference:\n` +
          `  ${toolMeta.name}: ${toolMeta.description}\n` +
          `  Parameters:\n${formatSchema(toolMeta.inputSchema)}\n` +
          `  Use /mcp reconnect ${serverName} to retry.`
        }],
        details: { mode: "call", error: "server_unavailable" }
      };
    }
  }
  
  // NEW: On tool call failure, attempt one reconnect + retry
  try {
    return await executeToolCall(state, serverName, toolMeta, args);
  } catch (error) {
    if (isConnectionError(error) && serverName) {
      const reconnected = await attemptReconnect(state, serverName);
      if (reconnected) {
        return await executeToolCall(state, serverName, toolMeta, args);
      }
    }
    throw error;
  }
}
```

### 4. Metadata Refresh on Notifications

```typescript
// In server-manager.ts, after connect:
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
  const tools = await this.fetchAllTools(client);
  connection.tools = tools;
  this.onToolsChanged?.(name, tools);
});
```

### 5. Enhanced Proxy Description — Tool Catalog

```typescript
// In direct-tools.ts, buildProxyDescription():
// Include full tool catalog as searchable text in the proxy description

const MAX_DESC_TOOLS = 50; // Don't bloat for huge servers
for (const [serverName, metadata] of state.toolMetadata.entries()) {
  if (metadata.length > MAX_DESC_TOOLS) {
    desc += `\n${serverName}: ${metadata.length} tools (use search to explore)`;
    continue;
  }
  desc += `\n${serverName}:\n`;
  for (const tool of metadata) {
    desc += `  - ${tool.name}: ${truncateAtWord(tool.description, 80)}\n`;
  }
}
```

This way the LLM sees ALL tool names + descriptions in the proxy tool's description
and can call the right tool in ONE turn instead of search → describe → call.

---

## Quick Wins (Can Do Immediately)

1. **Include tool catalog in proxy description** — the LLM already reads the proxy tool's description. Put all tool names + one-liners there. Saves 1-2 turns per tool discovery.

2. **Auto-connect on tool call** — remove the need for explicit `mcp({ connect: "server" })`. Just connect automatically when a tool is called to a disconnected server.

3. **Return schema on validation error** — when a tool call fails, include the expected schema in the error message so the LLM can self-correct.

4. **Connection timeout** — add a 30s timeout to `createConnection()` so a hung server doesn't block forever.

5. **ToolListChanged notification handler** — register the notification handler after connect so tool changes are reflected without manual reconnect.
