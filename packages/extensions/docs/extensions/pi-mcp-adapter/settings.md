# pi-mcp-adapter settings

Config file: `~/.pi/agent/mcp.json` (or `.pi/mcp.json` for project-local config)

Key sections:

- `mcpServers.<name>` (command/url, auth, lifecycle, direct tools, etc.)
- `settings` (`toolPrefix`, `idleTimeout`, `directTools`, `disableProxyTool`, `toonEncode`, `captureStats`)

## `settings.captureStats`

Optional. Captures per-server/per-tool MCP call statistics to a project-local JSON file.

- `true` — enable stats with defaults
- `false` / omitted — disabled (default)
- object — configure file path and flush delay:
  - `path` (string): output file path (relative paths are resolved from project root)
  - `flushDelayMs` (number): debounce window for writes (default `750`)

Default output path: `.pi/mcp-tool-stats.json`

Captured counters include:

- server totals: `calls`, `success`, `errors`, `proxyCalls`, `directCalls`
- per-tool totals: same counters plus `errorCodes` buckets
- timestamps: `lastCalledAt`, `lastSuccessAt`, `lastErrorAt`

Example:

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

## `settings.toonEncode`

Optional. Enables [TOON](https://github.com/toon-format/toon) encoding of JSON MCP tool responses to reduce token usage.

- `true` — encode all servers' JSON responses as TOON
- `false` / omitted — disabled (default)
- `string[]` — only encode responses from listed servers

Only applies to successful tool call results; errors and non-JSON text pass through unchanged. TOON is only used when it produces shorter output than the original.

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
| search_text (30 results) | 1,399 tok | 1,021 tok | −27% |
| find_references (100 results) | 6,195 tok | 4,705 tok | −24% |

CLI flag:

- `--mcp-config <path>` overrides config path
