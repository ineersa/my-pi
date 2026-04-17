# jetbrains-index

JetBrains index diagnostics gate for pi sessions.

## Features

- Uses `mcpServers.jetbrains-index` (streamable MCP transport).
- Injects a **strict IDE-index policy** into the agent system prompt (tool selection, pre-flight checks, sync rules, parameter rules, and common mistakes).
- Blocks `edit`/`write` calls when IDE index is busy (`ide_index_status`), retrying 3 times with a 5s delay.
- Captures baseline diagnostics for existing files before mutation (`ide_diagnostics`).
- After successful mutation, syncs file paths with `ide_sync_files`, re-runs diagnostics, and injects only newly introduced issues as:

```xml
<system-reminder>
<new-diagnostics>...</new-diagnostics>
</system-reminder>
```

- All failures are surfaced via UI notifications (no hard crashes).
- Emits token-efficiency reminders when the model does repeated unbounded `read` calls (with a 5-minute nudge cooldown to reduce spam).
- Enforces a hard read guardrail: after 4 consecutive unbounded reads over 200 lines, the next unbounded read is blocked, then the large-read streak is reset.
- Detects `mv` / `git mv` in bash commands and nudges toward IDE move refactoring (`ide_move_file`).
- Tracks mixed non-symbolic exploration bursts (`grep`, `read`, `bash` with `rg|grep|git grep|find`) and blocks once a threshold is reached; the counter resets on semantic IDE tool usage and deny actions are rate-limited with a cooldown.
- Adds a one-time session-start system nudge (when JetBrains index is available) to prefer IDE semantic tools first.

## Activation rule

This extension stays **disabled** unless **both** conditions are true:

1. Current working directory contains a `.idea/` folder
2. The `jetbrains-index` MCP server is reachable from one of:
   - `.pi/mcp.json`
   - `~/.pi/agent/mcp.json`
