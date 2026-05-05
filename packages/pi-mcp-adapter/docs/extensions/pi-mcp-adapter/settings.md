# pi-mcp-adapter settings

Config file: `~/.pi/agent/mcp.json` (or `.pi/mcp.json` for project-local config).

Key sections:

- `mcpServers.<name>` — per-server definitions (transport, auth, lifecycle, tool exposure)
- `settings` — global settings (`toolPrefix`, `idleTimeout`, `toonEncode`, `captureStats`)

---

## `settings.toolPrefix`

Controls how MCP tools are named when registered with Pi.

| Value | Example Name | Collision Risk | Token Cost |
|---|---|---|---|
| `"server"` (default) | `jetbrains_index__ide_search_text` | Low | Bare tool name + 1-2 words |
| `"short"` | `jetbrains_index__ide_search_text` | Medium (strips `-mcp` suffix) | Same as server |
| `"none"` | `ide_search_text` | High (raw names may overlap) | Shortest |

**What `short` strips:** The `-mcp` suffix (case-insensitive) from the server name
before building the prefix. `"playwright-mcp"` → `"playwright"`. Everything else
behaves like `"server"`.

---

## `settings.idleTimeout`

Global idle timeout in minutes. Connected servers are automatically disconnected after
this period of inactivity. On next tool call, the server reconnects lazily.

- Default: `10` minutes
- Set `0` to disable idle timeout globally
- Per-server `idleTimeout` overrides this
- `eager` servers default to `0` (never idle)
- In-flight tool calls block idle shutdown

Example:

```json
{
  "settings": {
    "idleTimeout": 30
  }
}
```

---

## `settings.captureStats`

Captures per-server/per-tool MCP call statistics to a project-local JSON file.

- `true` — enable stats with defaults (writes to `.pi/mcp-tool-stats.json`)
- `false` / omitted — disabled (default)
- `object` — configure file path and flush delay:
  - `path` (string): output file path (relative paths resolve from project root)
  - `flushDelayMs` (number): debounce window for writes (default `750`)

Captured counters include:

| Counter | Scope | Description |
|---|---|---|
| `calls` | Server + tool | Total call count |
| `success` | Server + tool | Successful calls |
| `errors` | Server + tool | Failed calls |
| `directCalls` | Server + tool | Direct-mode calls (not proxy) |
| `errorCodes` | Tool only | Breakdown by error code (e.g. `tool_error`, `server_unavailable`) |
| `lastCalledAt` | Server + tool | ISO timestamp |
| `lastSuccessAt` | Server + tool | Last success timestamp |
| `lastErrorAt` | Server + tool | Last error timestamp |

Basic example:

```json
{
  "settings": {
    "captureStats": true
  }
}
```

Custom path example:

```json
{
  "settings": {
    "captureStats": {
      "path": ".pi/mcp-stats/jetbrains.json",
      "flushDelayMs": 500
    }
  }
}
```

**Usage tip:** review stats periodically to decide which tools should be direct vs deferred.
A typical JetBrains session with 200 calls may show the top 5 tools covering 94.5% of usage.

---

## `settings.toonEncode`

Enables [TOON](https://github.com/toon-format/toon) encoding of JSON MCP tool responses
to reduce token usage.

- `true` — encode all servers' JSON responses as TOON
- `false` / omitted — disabled (default)
- `string[]` — only encode responses from listed servers

Only applies to successful tool call results. Errors and non-JSON text pass through
unchanged. TOON is only used when it produces shorter output than the original.

Best suited for servers that return uniform arrays of objects (e.g. `jetbrains-index`).

Example:

```json
{
  "settings": {
    "toonEncode": ["jetbrains-index"]
  }
}
```

Benchmark (JetBrains MCP responses):

| Scenario | JSON Compact | TOON | Savings |
|---|---|---|---|
| `search_text` (30 results) | 1,399 tok | 1,021 tok | −27% |
| `find_references` (100 results) | 6,195 tok | 4,705 tok | −24% |

Dependency: `@toon-format/toon` (bundled with the extension).

---

## Per-server `directTools`

Controls which tools bypass ToolSearch and are always active from session start.

- `true` — all tools from this server are direct
- `string[]` — only listed tools (by original MCP name) are direct
- `false` or omitted — all tools are deferred (discoverable via ToolSearch)

**Note:** There is no global `settings.directTools` in the current architecture.
This setting is per-server only.

Example (selective direct tools):

```json
{
  "mcpServers": {
    "jetbrains-index": {
      "url": "http://127.0.0.1:29175/index-mcp/streamable-http",
      "directTools": [
        "ide_search_text",
        "ide_diagnostics",
        "ide_find_references"
      ]
    }
  }
}
```

---

## Per-server `startupTimeoutMs`

Per-server connection timeout in milliseconds during `session_start` startup.

- Default: `30000` (30 seconds)
- Only applies to `eager` and `keep-alive` servers (lazy servers connect on demand)

Example:

```json
{
  "mcpServers": {
    "fast-server": {
      "url": "http://localhost:3000/sse",
      "lifecycle": "eager",
      "startupTimeoutMs": 5000
    }
  }
}
```

---

## Per-server `excludeTools`

Hide specific tools from being registered (both direct and deferred). Useful for
removing noisy or dangerous tools from the LLM's view.

Exclusion matches against:
1. Original MCP tool name (`ide_search_text`)
2. Prefixed name with `"server"` mode (`jetbrains_index__ide_search_text`)
3. Prefixed name with `"short"` mode (`jetbrains_index__ide_search_text`)

Example:

```json
{
  "mcpServers": {
    "database": {
      "url": "http://localhost:9090/sse",
      "excludeTools": ["read_logs", "delete_all_records"]
    }
  }
}
```

---

## Per-server `exposeResources`

Expose MCP resources as callable Pi tools named `get_<resource_name>`.

- `true` (default) — resources become callable tools
- `false` — skip resource tool creation

Resource names are normalized: stripped of special characters, collapsed underscores,
and forced to lowercase. Prefix `resource_` is added if the name starts with a digit.

---

## CLI flag

```
--mcp-config <path>    Override config file path (default: ~/.pi/agent/mcp.json)
```

---

## Config merge order

1. `~/.pi/agent/mcp.json` (or `--mcp-config`) — base config
2. `imports` — servers from Cursor, Claude Code, etc. (only if not already defined)
3. `.pi/mcp.json` (project root) — highest priority overrides

Each layer's `mcpServers` are merged (project overrides user, user overrides imports).
`settings` are shallow-merged (project overrides individual keys).
