# jetbrains-index

JetBrains index diagnostics gate for pi sessions.

## Features

- Uses `mcpServers.jetbrains-index` (streamable MCP transport).
- Blocks `edit`/`write` calls when IDE index is busy (`ide_index_status`), retrying 3 times with a 5s delay.
- Captures baseline diagnostics for existing files before mutation (`ide_diagnostics`).
- After successful mutation, syncs file paths with `ide_sync_files`, re-runs diagnostics, and injects only newly introduced issues as:

```xml
<system-reminder>
<new-diagnostics>...</new-diagnostics>
</system-reminder>
```

- All failures are surfaced via UI notifications (no hard crashes).

## Activation rule

This extension stays **disabled** unless **both** conditions are true:

1. Current working directory contains a `.idea/` folder
2. The `jetbrains-index` MCP server is reachable from one of:
   - `.pi/mcp.json`
   - `~/.pi/agent/mcp.json`
