# pi-mcp-adapter — Examples

> Every feature with config snippets and usage patterns.

---

## Example 1: ToolSearch Discovery

**What it does:** The LLM sees one `ToolSearch` tool in its active list instead of 70+ MCP tool schemas. When it needs a specific tool, it searches by keyword and the tool is activated for the next turn.

```json
{
  "settings": { "toolPrefix": "server" },
  "mcpServers": {
    "jetbrains-index": {
      "url": "http://127.0.0.1:29175/index-mcp/streamable-http"
    }
  }
}
```

**Usage:**

```
Turn 1: ToolSearch({ query: "jetbrains find definition" })
        → "Loaded 3 tools: jetbrains_index__ide_find_definition,
           jetbrains_index__ide_find_references,
           jetbrains_index__ide_find_super_methods"

Turn 2: jetbrains_index__ide_find_definition({ file: "src/Main.java", line: 15, column: 10 })
        → Returns the symbol definition with full preview
```

**Select mode** — load exact tools by prefixed name (bypasses keyword search):

```typescript
ToolSearch({ query: "select:jetbrains_index__ide_search_text,jetbrains_index__ide_diagnostics" })
```

**Search algorithm:** weighted scoring over tool name parts and descriptions:

| Score | Condition |
|---|---|
| 10 | Query term matches a tool name part **exactly** |
| 5 | Query term is a **substring** of a tool name part |
| 4 | Word-boundary match in the **description** |
| 3 | Query term is contained in the **full tool name** (fallback) |

Max 5 results per search.

---

## Example 2: Direct Tool Registration

**What it does:** Selected MCP tools are registered as first-class Pi tools from the very first
turn. No discovery round-trip needed. Configured per-server.

**All tools from a server are direct:**

```json
{
  "mcpServers": {
    "librarian": {
      "url": "http://localhost:8093/mcp",
      "directTools": true
    }
  }
}
```

**Only specific tools are direct (rest stay deferred):**

```json
{
  "mcpServers": {
    "jetbrains-index": {
      "url": "http://127.0.0.1:29175/index-mcp/streamable-http",
      "directTools": [
        "ide_search_text",
        "ide_diagnostics",
        "ide_find_references",
        "ide_find_file",
        "ide_find_class"
      ]
    }
  }
}
```

**Via environment variable (useful for subagents):**

```bash
MCP_DIRECT_TOOLS=playwright,database/query_tables pi
```

- `*` — all servers are direct
- `server_name` — all tools from that server
- `server_name/tool_name` — specific tool
- `__none__` — no direct tools (override all config)

**Performance tip:** use stats (see [Example 9](#example-9-call-statistics)) to find your
most-used tools and set only those as direct. In a typical JetBrains session with 200 calls,
the top 5 tools covered 94.5% of usage while the remaining 9+ stayed deferred.

---

## Example 3: Lazy Startup by Default

**What it does:** Servers default to `lifecycle: "lazy"` — they connect only when a tool call
needs them. Pi starts instantly regardless of how many servers are configured.

```json
{
  "mcpServers": {
    "rarely-used-db": {
      "url": "http://localhost:9090/sse"
    }
  }
}
```

The server stays disconnected until the agent calls one of its tools. On first call,
`createDirectToolExecutor` triggers a lazy connect with 60s failure backoff.

---

## Example 4: Three Lifecycle Modes

**What it does:** Controls when servers connect and whether they auto-reconnect.

| Mode | Startup Connection | Reconnect | Idle Timeout |
|---|---|---|---|
| `lazy` (default) | No | On first tool call | Yes (global default) |
| `eager` | Yes (session start) | Via `turn_end` hook | 0 (disabled) |
| `keep-alive` | Yes (session start) | 30s health check | Yes (global default) |

### Eager — connect at startup, no reconnect

```json
{
  "mcpServers": {
    "critical-server": {
      "command": "npx",
      "args": ["-y", "important-mcp"],
      "lifecycle": "eager",
      "startupTimeoutMs": 15000
    }
  }
}
```

Connects during `session_start` with a 15-second timeout. If it fails, the error is shown
once. No reconnect attempts — assume server is always running.

### Keep-alive — connect at startup + auto-reconnect

```json
{
  "mcpServers": {
    "daemon-server": {
      "url": "http://localhost:1234/sse",
      "lifecycle": "keep-alive"
    }
  }
}
```

Health check runs every 30 seconds. If the server disconnects, it's reconnected
automatically. Tool metadata is refreshed on reconnect.

### Lazy (default) — connect on demand

```json
{
  "mcpServers": {
    "occasional-server": {
      "command": "npx",
      "args": ["-y", "rarely-used-mcp"]
    }
  }
}
```

---

## Example 5: Idle Timeout

**What it does:** Connected servers are automatically disconnected after inactivity to
save resources. On next tool call, they reconnect lazily.

**Global idle timeout (applies to all servers):**

```json
{
  "settings": {
    "idleTimeout": 30
  }
}
```

30 minutes of inactivity before shutdown.

**Per-server override:**

```json
{
  "mcpServers": {
    "chatty-server": {
      "url": "http://localhost:5000/sse",
      "lifecycle": "keep-alive",
      "idleTimeout": 5
    },
    "always-hot": {
      "url": "http://localhost:6000/sse",
      "idleTimeout": 0
    }
  }
}
```

**Defaults:**
- Global: 10 minutes
- Eager servers: 0 (never idle)
- In-flight tool calls block idle shutdown (tracks `inFlight` counter)

---

## Example 6: Metadata Cache

**What it does:** Tool and resource metadata is cached to `~/.pi/agent/mcp-cache.json`
so Pi can register tools without connecting to servers on every startup.

**Cache entry per server:**

```json
{
  "version": 1,
  "servers": {
    "jetbrains-index": {
      "configHash": "sha256...",
      "tools": [
        {
          "name": "ide_search_text",
          "description": "Search using IDE word index",
          "inputSchema": { }
        },
        {
          "name": "ide_find_references",
          "description": "Find symbol references",
          "inputSchema": { }
        }
      ],
      "resources": [],
      "cachedAt": 1743545600000
    }
  }
}
```

**Cache invalidation triggers:**

- Config hash changes (different `command`, `url`, `args`, `headers`, etc.)
- Cache is older than 7 days
- Server is missing from cache entirely

When a server's cache is invalid, it's connected fresh on next `session_start`.

**Direct tools are registered from cache** at module load time (before `session_start`),
so they're available on turn 1 even on cold start (cache populates after first connection).

---

## Example 7: npx Binary Resolution

**What it does:** Instead of running `npx some-mcp` (which spawns a ~143MB npm parent
process per server), the extension resolves the actual binary path from npm's cache and
invokes it directly with `node` or executes the binary.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic/playwright-mcp"]
    }
  }
}
```

Under the hood, this resolves to something like:

```
node /home/user/.npm/_npx/abc123/node_modules/@anthropic/playwright-mcp/dist/index.js
```

**Resolution cache:** `~/.pi/agent/mcp-npx-cache.json` (24h TTL).

If resolution fails (uncached package, network issue), the extension falls back to the
original `npx` command transparently.

---

## Example 8: TOON Encoding

**What it does:** JSON tool responses are compressed using the
[TOON format](https://github.com/toon-format/toon) to reduce token usage. Only applied
when output is shorter than the original JSON.

**Enable for all servers:**

```json
{
  "settings": {
    "toonEncode": true
  }
}
```

**Enable for specific servers:**

```json
{
  "settings": {
    "toonEncode": ["jetbrains-index", "librarian"]
  }
}
```

**Benchmark (JetBrains MCP responses):**

| Scenario | JSON Compact | TOON | Savings |
|---|---|---|---|
| `search_text` (30 results) | 1,399 tok | 1,021 tok | **−27%** |
| `find_references` (100 results) | 6,195 tok | 4,705 tok | **−24%** |

TOON only applies to successful tool call results. Errors and non-JSON text pass through
unchanged. Best for servers that return uniform arrays of objects.

---

## Example 9: Call Statistics

**What it does:** Captures per-server, per-tool call counters to a project-local JSON file.
Useful for understanding which tools you actually use.

**Enable with defaults (writes to `.pi/mcp-tool-stats.json`):**

```json
{
  "settings": {
    "captureStats": true
  }
}
```

**Custom path and flush delay:**

```json
{
  "settings": {
    "captureStats": {
      "path": ".pi/mcp-stats/monitoring.json",
      "flushDelayMs": 500
    }
  }
}
```

**Reading the stats file** (after a session):

```json
{
  "version": 1,
  "projectRoot": "/home/user/projects/my-app",
  "servers": {
    "jetbrains-index": {
      "calls": 200,
      "success": 199,
      "errors": 1,
      "directCalls": 200,
      "tools": {
        "ide_search_text": {
          "calls": 106,
          "success": 105,
          "errors": 1,
          "errorCodes": { "tool_error": 1 },
          "lastCalledAt": "2026-04-25T16:43:32Z"
        },
        "ide_diagnostics": {
          "calls": 43,
          "success": 43,
          "errors": 0,
          "errorCodes": {},
          "lastCalledAt": "2026-04-24T13:11:28Z"
        }
      }
    }
  }
}
```

**Captured counters per tool:** `calls`, `success`, `errors`, `errorCodes` buckets,
`lastCalledAt`, `lastSuccessAt`, `lastErrorAt`.

Stats flush on session shutdown and after the configured debounce delay.

---

## Example 10: Config Imports

**What it does:** Import MCP server definitions from other tools you already use.
Local config takes precedence over imports, so you can override specific servers.

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"],
  "mcpServers": {
    "my-custom-server": {
      "command": "npx",
      "args": ["-y", "custom-mcp"]
    }
  }
}
```

**Supported import sources:**

| Kind | Config Path |
|---|---|
| `cursor` | `~/.cursor/mcp.json` |
| `claude-code` | `~/.claude/claude_desktop_config.json` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `codex` | `~/.codex/config.json` |
| `windsurf` | `~/.windsurf/mcp.json` |
| `vscode` | `.vscode/mcp.json` (project-relative) |

**Merge rules:**
1. User config (`~/.pi/agent/mcp.json`) is the base
2. Imported servers are added (only if not already defined)
3. Project config (`.pi/mcp.json`) overrides everything

---

## Example 11: Project-Local Config

**What it does:** Each project can have its own `.pi/mcp.json` that overrides the
user-global `~/.pi/agent/mcp.json`. Perfect for project-specific tooling.

**`.pi/mcp.json` (project root):**

```json
{
  "mcpServers": {
    "project-tools": {
      "command": "npx",
      "args": ["-y", "project-specific-mcp"],
      "lifecycle": "eager"
    }
  },
  "settings": {
    "toolPrefix": "short"
  }
}
```

**Merge priority:**

```
~/.pi/agent/mcp.json  (base)
  ↓ imports (cursor, claude, etc.)
    ↓ .pi/mcp.json  (highest — overrides everything)
```

Project settings merge with user settings (user is base, project overrides individual keys).

---

## Example 12: Resource Tools

**What it does:** MCP resources (files, data endpoints) are automatically exposed as
callable Pi tools named `get_resource_name`.

**Server-side (exposes resources):**

```json
{
  "mcpServers": {
    "docs-server": {
      "url": "http://localhost:7000/sse"
    }
  }
}
```

**Resulting tools:**
- If the server provides a resource named `project-readme` with URI `docs://readme`
- Pi registers: `docs_server__get_project_readme` as a callable tool
- Calling it reads the resource via the MCP `resources/read` endpoint

**To disable resource tools:**

```json
{
  "mcpServers": {
    "jetbrains-index": {
      "url": "http://127.0.0.1:29175/index-mcp/streamable-http",
      "exposeResources": false
    }
  }
}
```

Resource name normalization: `resourceNameToToolName()` strips special characters,
collapses underscores, and ensures a valid JS identifier.

---

## Example 13: Failure Backoff

**What it does:** When a server fails to connect, subsequent attempts are blocked for
60 seconds. This prevents connection storms when a server is down.

```json
{
  "mcpServers": {
    "flakey-server": {
      "url": "http://localhost:9999/sse"
    }
  }
}
```

**Failure flow:**

```
Turn 1:  Agent calls tool on flakey-server
         → lazyConnect fails, stores failure timestamp
         → Returns "server not available (failed 0s ago)"

Turn 2:  Agent calls another tool on flakey-server
         → failureBackoff still active
         → Returns "server not available (failed 30s ago)"

1 min later:
         Agent calls tool again
         → Failure expired
         → lazyConnect retries the connection
```

Failure timestamps are stored in `failureTracker` (in-memory, resets on session restart).

---

## Example 14: Bear Your Own Auth

**What it does:** Supports bearer token authentication for HTTP servers. OAuth servers
are detected and reported as `needs-auth` — tool calls are skipped instead of blocking.

**Bearer token from env var:**

```json
{
  "mcpServers": {
    "auth-server": {
      "url": "https://api.example.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "MY_MCP_TOKEN"
    }
  }
}
```

**Bearer token inline (less secure):**

```json
{
  "mcpServers": {
    "auth-server": {
      "url": "https://api.example.com/mcp",
      "auth": "bearer",
      "bearerToken": "sk-abc123..."
    }
  }
}
```

**Token interpolation in headers and env vars:**

```json
{
  "mcpServers": {
    "api-server": {
      "url": "http://localhost:8000/sse",
      "headers": {
        "Authorization": "Bearer ${AUTH_TOKEN}",
        "X-Custom": "$env:CUSTOM_HEADER"
      },
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

Both `${VAR}` and `$env:VAR` syntaxes are supported.

**OAuth servers:** If a server returns `UnauthorizedError` during connect, it enters
`needs-auth` state. All tool calls return a descriptive error instead of trying to
connect. No OAuth flow is implemented in this slimmed fork.

---

## Example 15: Builtin Collision Guard

**What it does:** If an MCP tool's prefixed name collides with a Pi builtin
(`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), it's silently skipped with a
warning.

```json
{
  "mcpServers": {
    "dangerous": {
      "command": "npx",
      "args": ["-y", "badly-named-mcp"],
      "directTools": true
    }
  }
}
```

**Warning in logs:**

```
MCP: skipping tool "read" (collides with builtin)
MCP: skipping direct tool "bash" (collides with builtin)
```

This applies to both direct and deferred tools. The collision is checked against
the **prefixed** name (e.g., `dangerous_read`), so collisions are rare unless using
`prefix: "none"`.

---

## Example 16: Cross-server Deduplication

**What it does:** When `prefix: "short"` or `prefix: "none"` produces the same tool name
from different servers, only the first one is registered.

```json
{
  "settings": {
    "toolPrefix": "none"
  },
  "mcpServers": {
    "server-a": {
      "command": "npx",
      "args": ["-y", "package-a"]
    },
    "server-b": {
      "command": "npx",
      "args": ["-y", "package-b"]
    }
  }
}
```

With `prefix: "none"`, both tools would be named `get_data`.
The first one registered wins; the second is skipped with a console warning:

```
MCP: skipping duplicate direct tool "get_data" from "server-b"
```

**Prefix modes & how they avoid collisions:**

| Mode | Example Name | Collision Risk |
|---|---|---|
| `server` (default) | `server_a__get_data` | Low — server name disambiguates |
| `short` | `a__get_data` | Medium — short names may overlap |
| `none` | `get_data` | High — raw tool names |

---

## Example 17: Status Bar

**What it does:** Shows the MCP connection status in Pi's footer as a compact indicator.

When connected to 5 out of 6 servers:

```
MCP: 5/6 servers
```

When all servers are disabled or none configured, the status bar entry is hidden.

The status bar updates:
- After `session_start` (initial connect)
- When a server connects or reconnects
- When a server is closed (idle timeout or manual)
- After `/mcp reconnect`
