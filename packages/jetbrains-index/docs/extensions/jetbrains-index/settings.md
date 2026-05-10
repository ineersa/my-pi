# jetbrains-index settings

## Activation

This extension is active only when:

- The current working directory contains a `.idea/` directory.
- A `jetbrains-index` MCP server is configured in either:
  - `.pi/mcp.json`, or
  - `~/.pi/agent/mcp.json`

If either requirement is missing, the extension disables itself for the session and shows a UI notification.

## Runtime configuration

There is no package-local JSON settings file for this extension today.
Behavior is controlled by built-in constants in:

- `extensions/jetbrains-index/constants.ts`

Key built-in limits/intervals:

- Index readiness retries before edit/write: `5`
- Index readiness retry backoff: exponential from `2s`, capped at `30s`
- Large read threshold: `>200` lines
- Large unbounded read block threshold: `4` consecutive large unbounded reads
- Mixed non-symbolic block threshold: weighted streak `>=6` (driven by **large** unbounded reads)
- Nudge cooldown: `5 minutes`
- Non-symbolic deny cooldown: `120 seconds`

Read-streak behavior:

- Unbounded reads below the large-read threshold do not contribute to the non-symbolic deny streak.
- Semantic IDE tool calls reset read/non-symbolic streak pressure.
- Regex-style shell search (`rg`/`grep` via `bash`/`grep`) also resets streak pressure.

## Tool expectations

The extension is designed for JetBrains index IDE tools (including proxy mode via `mcp`). It prefers semantic tools such as:

- `jetbrains_index__ide_find_file`
- `jetbrains_index__ide_search_text`
- `jetbrains_index__ide_find_definition`
- `jetbrains_index__ide_find_references`
- `jetbrains_index__ide_diagnostics`
- `jetbrains_index__ide_sync_files`
