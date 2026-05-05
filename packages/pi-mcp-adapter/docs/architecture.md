# pi-mcp-adapter — Architecture Document

> Compiled from source (`pi-mcp-adapter.ts`, `init.ts`, `config.ts`, `server-manager.ts`,
> `lifecycle.ts`, `tool-search.ts`, `direct-tools.ts`, `metadata-cache.ts`, `npx-resolver.ts`,
> `tool-metadata.ts`, `commands.ts`, `types.ts`, `state.ts`) and plan documents
> (`TOOLSEARCH-PLAN.md`, `PROGRESS.md`, `pass-1-foundation.md`, `pass-2-integration.md`).
>
> This document is the single source of truth for understanding how the extension works.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Core Concepts](#2-core-concepts)
3. [Module Map](#3-module-map)
4. [Lifecycle](#4-lifecycle)
5. [Config Loading & Merge Strategy](#5-config-loading--merge-strategy)
6. [Tool Registration Strategy](#6-tool-registration-strategy)
7. [ToolSearch — Discovery & Activation](#7-toolsearch--discovery--activation)
8. [Server Lifecycle Management](#8-server-lifecycle-management)
9. [Metadata Cache](#9-metadata-cache)
10. [npx Binary Resolution](#10-npx-binary-resolution)
11. [Transport Layer](#11-transport-layer)
12. [Data Flow](#12-data-flow)
13. [Configuration Reference](#13-configuration-reference)

---

## 1. Overview

`pi-mcp-adapter` bridges Pi (the coding agent) with MCP (Model Context Protocol) servers.
It manages the entire lifecycle of MCP server connections and makes their tools available
to the LLM in a token-efficient way.

**Key architectural shift (v2.4 → current):** The old single `mcp` proxy mega-tool with
generic `{tool?, args?, search?, ...}` schema has been replaced by a **ToolSearch** pattern.
Every MCP tool is registered individually with its full typed schema, but only a subset
are active at any time. This saves 2000+ tokens per turn while keeping all functionality
available on demand.

### Design Goals

- **Token efficiency** — only the tools the LLM needs are active at any time
- **Fast startup** — metadata cache enables tool registration without server connections
- **Reliable lifecycle** — health checks, idle timeout, reconnect with backoff
- **Config flexibility** — multi-source merge (user → imports → project), per-server overrides
- **Zero-build** — the extension runs as raw TypeScript, no compilation step

---

## 2. Core Concepts

### Direct vs Deferred Tools

| Concept | Direct | Deferred |
|---|---|---|
| **Active at startup?** | Yes | No |
| **Schema visible?** | From turn 1 | After ToolSearch call + 1 turn |
| **Discovery method** | Config-driven (`directTools`, `MCP_DIRECT_TOOLS`) | ToolSearch keyword or `select:` |
| **Token cost** | Higher (always in prompt) | Lower (only when loaded) |
| **Use case** | Frequently used tools | Infrequent or niche tools |

### Tool Name Format

Tools are named with a `__` separator between the server prefix and original tool name:

```
<server_prefix>__<tool_name>
```

- `server_prefix` = server name with hyphens replaced by underscores (e.g. `jetbrains-index` → `jetbrains_index`)
- `tool_name` = original MCP tool name

**Example:** `jetbrains_index__ide_find_definition`

The prefix mode is configurable:
- `"server"` (default) — full server name
- `"short"` — stripped server name (removes `-mcp` suffix, hyphens → underscores)
- `"none"` — no prefix (risk of collisions)

### ToolSearch Pattern

```
Startup: [builtins] + [ToolSearch] + [direct tools] — active
         [deferred tools] — registered but INACTIVE

Turn 1:  LLM sees ToolSearch, calls ToolSearch({ query: "..." })
         → ToolSearch finds matches, calls setActiveTools()

Turn 2:  LLM sees matched tools with full typed schemas
         → LLM calls them directly with proper parameters
```

---

## 3. Module Map

```
pi-mcp-adapter.ts          ← Entry point, tool registration, lifecycle hooks
├── config.ts              ← Config loading, merging, import resolution
├── state.ts               ← McpExtensionState type definition
├── init.ts                ← Lifecycle bootstrap, server connections, metadata update
├── types.ts               ← Core types, tool name formatting, exclusion logic
├── server-manager.ts      ← MCP SDK Client + transport management
├── lifecycle.ts           ← Health checks, idle timeout, reconnect callbacks
├── tool-search.ts         ← ToolSearch tool: search, activate, catalog
├── direct-tools.ts        ← Direct tool resolution + executor factory
├── metadata-cache.ts      ← Persistent cache with SHA256 config hashing
├── tool-metadata.ts       ← Build metadata from server tools/resources
├── tool-registrar.ts      ← MCP content → Pi content block transformation
├── commands.ts            ← /mcp command handlers (status, tools, reconnect)
├── npx-resolver.ts        ← npx binary resolution (skip npm parent process)
├── resource-tools.ts      ← MCP resource name → tool name normalization
├── toon-encoder.ts        ← Optional TOON encoding of JSON responses
├── stats.ts               ← Optional call statistics tracking
├── errors.ts              ← Structured error types (legacy UI integration)
└── logger.ts              ← Structured logging with levels
```

### Module Dependency Graph

```
pi-mcp-adapter.ts
├── config.ts          → types.ts, (fs, os, path)
├── init.ts            → config.ts, lifecycle.ts, server-manager.ts, tool-metadata.ts
│                      → metadata-cache.ts, direct-tools.ts, stats.ts, utils.ts
├── tool-search.ts     → state.ts, types.ts, (typebox)
├── direct-tools.ts    → state.ts, types.ts, tool-metadata.ts, tool-registrar.ts
│                      → toon-encoder.ts, metadata-cache.ts, init.ts, resource-tools.ts
├── commands.ts        → state.ts, init.ts, types.ts, tool-metadata.ts
├── server-manager.ts  → types.ts, npx-resolver.ts, logger.ts
├── lifecycle.ts       → types.ts, server-manager.ts, logger.ts
├── metadata-cache.ts  → types.ts, resource-tools.ts, (fs, crypto)
├── tool-metadata.ts   → state.ts, types.ts, resource-tools.ts
├── tool-registrar.ts  → types.ts
├── stats.ts           → types.ts, logger.ts, (fs)
├── toon-encoder.ts    → types.ts, (@toon-format/toon)
├── npx-resolver.ts    → (fs, child_process)
├── resource-tools.ts  → (no internal deps)
├── errors.ts          → (no internal deps, standalone)
└── logger.ts          → (no internal deps, standalone)
```

---

## 4. Lifecycle

### Startup Sequence

```
┌─────────────────────────────────────────────────────────┐
│ Early (module scope, before session_start)               │
├─────────────────────────────────────────────────────────┤
│ 1. Load config from ~/.pi/agent/mcp.json (or --mcp-config)│
│ 2. Load metadata cache from ~/.pi/agent/mcp-cache.json   │
│ 3. Resolve direct tools from cache + config              │
│ 4. Register direct tools immediately (pi.registerTool)   │
│    → Available before session_start completes             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ session_start                                            │
├─────────────────────────────────────────────────────────┤
│ 1. Shut down previous state (if any)                     │
│    - Flush metadata cache                                │
│    - Flush stats                                         │
│    - Graceful shutdown of all server connections         │
│                                                          │
│ 2. Initialize MCP state                                  │
│    - Create McpServerManager, McpLifecycleManager        │
│    - Load config + metadata cache                        │
│    - Register servers in lifecycle manager               │
│    - Mark keep-alive servers                             │
│    - Restore tool metadata from cache                    │
│      (for servers with valid cached entries)             │
│                                                          │
│ 3. Connect eager/keep-alive servers (parallel, limit 10) │
│    - 30s timeout per server                              │
│    - On connect: build metadata, update cache            │
│    - On failure: notify user, skip with backoff          │
│    - On needs-auth: mark, notify user                    │
│                                                          │
│ 4. Bootstrap direct-tool servers missing from cache      │
│    - If MCP_DIRECT_TOOLS env is set, connect servers     │
│      whose direct tools are configured but not cached    │
│    - Notify user: tools available after restart          │
│                                                          │
│ 5. Register ALL MCP tools (from connected + cached)      │
│    - pi.registerTool() for each (auto-activates)         │
│    - Skip tools colliding with BUILTIN_NAMES             │
│    - Track which are direct vs deferred                  │
│                                                          │
│ 6. Register ToolSearch tool                              │
│    - Always active                                       │
│    - Catalog description lists all deferred tools        │
│                                                          │
│ 7. Narrow active tools                                   │
│    pi.setActiveTools([...builtins, "ToolSearch", ...direct])│
│    → Deferred tools are registered but INACTIVE          │
│                                                          │
│ 8. Set reconnect callback                                │
│    On reconnect: update metadata, update cache,          │
│    re-register ToolSearch with fresh catalog             │
│                                                          │
│ 9. Start health checks (30s interval)                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ turn_end (keep-alive hook)                               │
├─────────────────────────────────────────────────────────┤
│ For each server with lifecycle "keep-alive" or "eager":  │
│   If not connected → call lazyConnect()                  │
│   (lazyConnect handles backoff, notifies on failure)     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ session_end / shutdown                                   │
├─────────────────────────────────────────────────────────┤
│ 1. Flush metadata cache for all connected servers        │
│ 2. Flush stats tracker                                   │
│ 3. Clear health check interval                           │
│ 4. Close all server connections                          │
└─────────────────────────────────────────────────────────┘
```

### Lifecycle Generation Guard

To handle rapid `session_start` → `session_start` transitions (e.g. during `/reload`),
a generation counter prevents stale async init results from replacing newer state:

```typescript
let lifecycleGeneration = 0;

// On session_start:
const generation = ++lifecycleGeneration;
// ... async init ...
promise.then(nextState => {
  if (generation !== lifecycleGeneration) return; // stale
  state = nextState;
});
```

---

## 5. Config Loading & Merge Strategy

### Config File Locations

| Priority | Path | Scope |
|---|---|---|
| 1 (highest) | `.pi/mcp.json` (project root) | Project-local overrides |
| 2 | Imported configs (Cursor, Claude, etc.) | Merged from other tools |
| 3 (base) | `~/.pi/agent/mcp.json` | User global config |
| Override | `--mcp-config <path>` CLI flag | Any path |

### Merge Rules

1. Start with user config (`~/.pi/agent/mcp.json` or `--mcp-config`)
2. Process `imports` array (Cursor, Claude Code, Claude Desktop, Codex, Windsurf, VS Code)
   - Imported servers are added only if not already defined in user config
3. Apply project config (`.pi/mcp.json`)
   - Project config servers override everything
   - Project settings merge with user settings (user is base, project overrides)

### Config Shape

```jsonc
{
  "mcpServers": {
    "server-name": {
      "enabled": true | false,        // disabled servers stay in config but are skipped
      "command": "npx",               // stdio transport
      "args": ["-y", "some-mcp"],
      "env": { "KEY": "${VAR}" },     // ${VAR} interpolation
      "cwd": "/path/to/work",
      "url": "http://host:port/sse",  // HTTP transport (alternative to command)
      "headers": { "Auth": "Bearer ${TOKEN}" },
      "auth": "bearer",
      "bearerToken": "xxx",
      "bearerTokenEnv": "MY_TOKEN",
      "lifecycle": "lazy" | "eager" | "keep-alive",
      "idleTimeout": 10,              // minutes (overrides global)
      "startupTimeoutMs": 30000,      // per-server connection timeout (ms)
      "exposeResources": true,
      "directTools": true | ["tool1", "tool2"] | false,
      "excludeTools": ["tool_name", "prefix_tool_name"],
      "debug": false                  // show server stderr
    }
  },
  "imports": ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"],
  "settings": {
    "toolPrefix": "server" | "short" | "none",
    "idleTimeout": 10,
    "toonEncode": true | ["server1"],
    "captureStats": true | { "path": "...", "flushDelayMs": 500 }
  }
}
```

### Config Validation

- `mcpServers` must be a plain object (not array)
- Supports both `mcpServers` and `mcp-servers` (kebab-case) keys
- Settings are optional; defaults are applied at runtime

---

## 6. Tool Registration Strategy

### Registration Flow

```
                   ┌─────────────────────────┐
                   │ Early (module scope)      │
                   │                          │
                   │ config + cache loaded     │
                   │ resolveDirectTools()     │
                   │                          │
                   │ For each direct tool:     │
                   │   pi.registerTool()      │
                   │   → immediately active    │
                   └──────────┬──────────────┘
                              │
                   ┌──────────▼──────────────┐
                   │ session_start            │
                   │                          │
                   │ 1. builtinActive =        │
                   │    pi.getActiveTools()    │
                   │    → snapshot BEFORE MCP  │
                   │                          │
                   │ 2. For each MCP tool:     │
                   │    pi.registerTool()      │
                   │    → auto-activates       │
                   │    (temporarily)          │
                   │                          │
                   │ 3. pi.registerTool(       │
                   │    ToolSearch)            │
                   │    → always active        │
                   │                          │
                   │ 4. pi.setActiveTools([    │
                   │    ...builtinActive,      │
                   │    "ToolSearch",          │
                   │    ...directToolNames     │
                   │  ]) → narrows back        │
                   └──────────┬──────────────┘
                              │
                   ┌──────────▼──────────────┐
                   │ Active tools:            │
                   │                          │
                   │ • Builtins (read, bash,  │
                   │   edit, write, ...)      │
                   │ • ToolSearch             │
                   │ • Direct MCP tools       │
                   │                          │
                   │ Inactive (registered):   │
                   │ • All other MCP tools    │
                   │   → activated on demand  │
                   │     via ToolSearch       │
                   └─────────────────────────┘
```

### Builtin Collision Guard

Tools whose prefixed name collides with a builtin are skipped with a warning:

```typescript
const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
```

### Direct Tool Resolution Priority

1. `MCP_DIRECT_TOOLS` environment variable (highest)
   - `*` = all servers are direct
   - `server_name` = all tools from that server are direct
   - `server_name/tool_name` = specific tool is direct
   - `MCP_DIRECT_TOOLS=__none__` = no direct tools
2. Per-server `directTools` config field
   - `true` = all tools from that server are direct
   - `["tool1", "tool2"]` = only listed tools are direct
   - `false` or omitted = deferred (need ToolSearch)

### Deduplication

When `prefix: "none"` or `prefix: "short"` produces collisions,
the first registered tool wins; duplicates are skipped with a warning.

---

## 7. ToolSearch — Discovery & Activation

### ToolSearch Tool Definition

Registered in the active tool set as `"ToolSearch"`. The LLM sees this tool's
description as a catalog of all available deferred MCP tools.

```typescript
{
  name: "ToolSearch",
  description: buildToolSearchDescription(state),
  parameters: {
    query: string  // "select:name1,name2" or keywords
  }
}
```

### Search Algorithm

Weighted scoring:

| Score | Condition |
|---|---|
| 10 | Query term matches **exactly** a part of the tool name |
| 5 | Query term is a **substring** of a tool name part |
| 4 | Word-boundary match in **description** |
| 3 | Query term is contained in **full tool name** (fallback) |

Maximum 5 results per search.

### Activation Flow

```
LLM calls ToolSearch({ query: "keywords" })
  → searchByKeywords(query, deferredTools)
  → matches sorted by score
  → loadAndActivate(pi, matchedNames, deferredTools)
    → pi.setActiveTools([...previous, ...newNames])
    → Returns: "Loaded 3 tools. You can call them next turn..."

Next turn:
  LLM sees the tools with full typed parameter schemas
  LLM calls tool_name({ param: "value" })
```

### Catalog Description

The ToolSearch tool description is dynamically built from the current metadata cache.
It groups tools by server and shows one-line descriptions.

**Select mode**: `ToolSearch({ query: "select:server_name__tool_name" })` loads exact tools
by their prefixed name, bypassing the search algorithm.

---

## 8. Server Lifecycle Management

### Lifecycle Modes

| Mode | Startup | Reconnect | Idle Timeout |
|---|---|---|---|
| `lazy` (default) | No | On tool call | Yes |
| `eager` | Yes (on session start) | Via `turn_end` hook | 0 (never) |  
| `keep-alive` | Yes (on session start) | Health check (30s) | Yes |

### Health Check System

Runs every 30 seconds (via `setInterval` with `.unref()`):

1. For keep-alive servers: check if connected → reconnect if disconnected
2. For all other servers: check idle timeout → close if idle

### Idle Timeout

- Global default: 10 minutes (`settings.idleTimeout`)
- Per-server override: `server.idleTimeout` (minutes)
- `eager` servers: idleTimeout defaults to 0 (never idle)
- `idleTimeout: 0` disables idle shutdown for that server
- In-flight requests prevent idle shutdown (tracks `inFlight` counter)

### Failure Backoff

When a connection fails:
- The failure timestamp is stored in `failureTracker`
- Subsequent connection attempts are blocked for 60 seconds
- After 60 seconds, connection is retried on next tool call

### Reconnect Callback

When a server reconnects (auto or manual):
1. Update tool metadata from fresh server tools/resources
2. Update metadata cache
3. Clear failure tracker entry
4. Re-register ToolSearch with updated catalog
5. Update status bar

### Connection States

```
┌─────────┐     connect()     ┌───────────┐
│  init   │ ────────────────→ │ connected │
└─────────┘                   └─────┬─────┘
      │                              │
      │  needs-auth                  │  idle timeout
      ▼                              ▼
┌───────────┐                 ┌──────────┐
│needs-auth │                 │  closed  │
└───────────┘                 └─────┬────┘
      │                              │
      │  reconnect                   │  tool call
      └──────────────────────────────┘
```

---

## 9. Metadata Cache

### Purpose

Eliminates the need to connect to servers on every startup. Tools and resources
are cached so they can be registered immediately without network calls.

### Storage

- **File:** `~/.pi/agent/mcp-cache.json`
- **Format:** JSON with versioning (`version: 1`)
- **Max age:** 7 days (configurable via `isServerCacheValid`)

### Cache Entry

```typescript
interface ServerCacheEntry {
  configHash: string;      // SHA256 of server identity fields
  tools: CachedTool[];     // tool name, description, inputSchema
  resources: CachedResource[];
  cachedAt: number;        // timestamp
}
```

### Config Hash

SHA256 hash of server fields that affect tool/resource output:
`command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, `bearerToken`,
`bearerTokenEnv`, `exposeResources`, `excludeTools`

Excluded from hash (runtime behavior only): `lifecycle`, `idleTimeout`, `debug`

### Cache Invalidation

A server's cache entry is invalid if:
- Config hash doesn't match the current definition
- Cache entry has no `cachedAt` timestamp
- Cache age exceeds `maxAgeMs` (default 7 days)
- Any of the above → server is connected fresh at startup

### Multi-session Safety

Uses read-merge-write with per-process temp files:

```typescript
const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
renameSync(tmpPath, CACHE_PATH);
```

---

## 10. npx Binary Resolution

### Problem

Running `npx some-mcp` creates an ~143 MB npm parent process per server.
This consumes unnecessary memory and CPU.

### Solution

Resolve the actual binary path from npm's cache and invoke it directly:

1. Parse `npx` args to extract package spec and bin name
2. Check local cache (`~/.pi/agent/mcp-npx-cache.json`, 24h TTL)
3. Resolve from npm cache directory (`_npx/...`)
4. If not cached, force `npm exec` to populate the cache, then resolve
5. Return direct binary path + extra args

### Resolution Result

```typescript
interface NpxResolution {
  binPath: string;       // Resolved binary path (e.g. /home/user/.npm/_npx/.../node_modules/.bin/mcp-server)
  extraArgs: string[];   // Remaining args after npx parsing
  isJs: boolean;         // Whether the binary is a JS file (needs node)
}
```

### Edge Cases

- `-p` / `--package` flags for specifying package explicitly
- Scoped packages (`@scope/package`)
- Shebang detection to determine if the binary runs with `node`
- If resolution fails, falls back to the original `npx` command

---

## 11. Transport Layer

### Supported Transports

| Transport | When Used | Auto-detection |
|---|---|---|
| `StdioClientTransport` | `command` field present | Always for stdio |
| `StreamableHTTPClientTransport` | `url` field present | Tried first for HTTP |
| `SSEClientTransport` | `url` field present | Fallback if StreamableHTTP fails |

### Transport Selection Logic (HTTP)

```typescript
try {
  // Probe with StreamableHTTP
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(...);
  await client.connect(transport);
  await client.close();
  // StreamableHTTP works → use it
  return new StreamableHTTPClientTransport(url);
} catch {
  // StreamableHTTP failed → fall back to SSE
  return new SSEClientTransport(url);
}
```

### HTTP Transport Auth

- Bearer token: set `Authorization` header
- Token sources: `bearerToken` field, `bearerTokenEnv` env var, or direct config
- `${VAR}` and `$env:VAR` interpolation supported in headers and env vars

### Transport Error Handling

- `UnauthorizedError` → connection enters `"needs-auth"` state
- All other errors → thrown to caller for backoff/reconnect handling
- `debug: true` per-server shows server stderr

---

## 12. Data Flow

### Tool Call Execution

```
┌────────┐   1. LLM calls    ┌──────────────────────┐
│  LLM   │ ───────────────→  │ createDirectToolExecutor│
└────────┘                   └──────────┬───────────┘
                                        │
                    2. Lazy connect to server (if needed)
                                        │
                    ┌───────────────────▼────────────┐
                    │  Server connected?              │
                    │  ├─ No, needs-auth → return error│
                    │  ├─ No, failed → return error   │
                    │  └─ Yes → continue               │
                    └───────────────────┬────────────┘
                                        │
                    3. Call tool        │
                    (resource path or   │
                    MCP tool call)      │
                                        │
                    ┌───────────────────▼────────────┐
                    │  Resource or Tool?               │
                    │  ├─ Resource → client.readResource│
                    │  └─ Tool → client.callTool       │
                    └───────────────────┬────────────┘
                                        │
                    4. Transform response
                                        │
                    ┌───────────────────▼────────────┐
                    │  transformMcpContent()           │
                    │  → MCP types → Pi content blocks │
                    │                                  │
                    │  maybeEncodeToon()  (optional)    │
                    │  → JSON → TOON if shorter         │
                    │                                  │
                    │  record stats  (optional)         │
                    └───────────────────┬────────────┘
                                        │
                    ┌───────────────────▼────────────┐
                    │  Return to LLM                  │
                    │  { content: [...], details }    │
                    └────────────────────────────────┘
```

### Error Response Flow

When a tool call fails, the executor:
1. Returns a descriptive text error
2. If the tool has an `inputSchema`, appends formatted parameter info
3. Records error in stats tracker (if enabled)
4. Does NOT throw — errors are returned as tool results

---

## 13. Configuration Reference

### Top-level fields

```jsonc
{
  // Required: Map of server names to server definitions
  "mcpServers": { ... },

  // Optional: Import MCP servers from other tools
  "imports": ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"],

  // Optional: Global settings
  "settings": {
    "toolPrefix": "server",           // Prefix style for tool names
    "idleTimeout": 10,                // Minutes before idle disconnect
    "toonEncode": ["jetbrains-index"], // Servers to TOON-encode
    "captureStats": true              // Enable call statistics
  }
}
```

### Per-server fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Disable without removing from config |
| `command` | `string` | — | Executable for stdio transport |
| `args` | `string[]` | `[]` | Command arguments |
| `env` | `Record<string,string>` | — | Environment variables (`${VAR}` supported) |
| `cwd` | `string` | — | Working directory |
| `url` | `string` | — | HTTP endpoint (alternative to command) |
| `headers` | `Record<string,string>` | — | HTTP headers (`${VAR}` supported) |
| `auth` | `"bearer"` or `false` | — | Authentication type |
| `bearerToken` | `string` | — | Static bearer token |
| `bearerTokenEnv` | `string` | — | Env var name for bearer token |
| `lifecycle` | `"lazy"` / `"eager"` / `"keep-alive"` | `"lazy"` | Connection lifecycle mode |
| `idleTimeout` | `number` | global default | Minutes before idle disconnect |
| `startupTimeoutMs` | `number` | `30000` | Connection timeout at startup |
| `exposeResources` | `boolean` | `true` | Expose MCP resources as tools |
| `directTools` | `boolean` / `string[]` | `false` | Make tools always active |
| `excludeTools` | `string[]` | — | Hide specific tools |
| `debug` | `boolean` | `false` | Show server stderr |

### CLI

```
--mcp-config <path>    Override config file path (default: ~/.pi/agent/mcp.json)
```

### Environment Variables

```
MCP_DIRECT_TOOLS       Comma-separated server/tool specifiers for direct tools
                       *       = all servers
                       server  = all tools from server
                       server/tool = specific tool
                       __none__    = no direct tools
```


*This document was compiled from the pi-mcp-adapter source tree and planning documents.*
