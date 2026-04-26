# @ineersa/my-pi-jetbrains-index

[pi-coding-agent](https://github.com/badlogic/pi-mono) extension that enforces **JetBrains IDE index–first** coding workflows. It injects policy reminders, blocks unsafe edits while the IDE is indexing, runs post-mutation diagnostics, and nudges agents toward semantic IDE tools over raw grep/read/bash exploration.

## Mandatory dependency

**[jetbrains-index-mcp-plugin](https://github.com/hechtcarmel/jetbrains-index-mcp-plugin)** must be installed and configured as an MCP server.  
This extension communicates with the JetBrains IDE through that MCP server — without it, the extension self-disables for the session.

## Activation requirements (both must be true)

1. `.idea/` exists in the current working directory (i.e. a JetBrains project is open).
2. A JetBrains index MCP server (`jetbrains-index`) is configured and reachable in `.pi/mcp.json` or `~/.pi/agent/mcp.json`.

If either condition is missing, the extension self-disables — no policy injections, no guardrails, no diagnostics.

## Install

```bash
pi install npm:@ineersa/my-pi-jetbrains-index
```

Local dev:

```bash
pi install ./packages/jetbrains-index -l
```

## What it does

### IDE-index policy injection

Appends a strict system-reminder policy at the start of every agent turn:

- Maps common tasks to the correct IDE tool (find usages → `ide_find_references`, rename → `ide_refactor_rename`, etc.)
- Enforces pre-flight checks (`ide_index_status`, `ide_sync_files`)
- Specifies parameter rules (project-relative paths, 1-based line/column, column on symbol name)
- Lists common mistakes to avoid (grep for semantic usages, text replace for rename, `mv` for code moves)

### Edit/write blocking during IDE indexing

Before every `edit` or `write` call:

1. Checks `ide_index_status` — if the IDE is in dumb mode (indexing), the edit is **blocked**.
2. Retries up to 3 times with a 5-second delay between attempts.
3. If all retries fail, the extension disables itself for the rest of the session (subsequent edits proceed without index checks).

### Post-mutation diagnostics

After every successful `edit` or `write`:

1. Captures baseline diagnostics before the mutation.
2. Syncs the changed file path with `ide_sync_files`.
3. Re-runs `ide_diagnostics` and reports **only newly introduced** issues (not pre-existing ones).
4. Injects the new diagnostics as a `<system-reminder>` appended to the tool result.

### Read-efficiency guardrails

- Tracks unbounded `read` calls (no `offset`/`limit`) per turn.
- Warns on large unbounded reads (>200 lines) with token-efficiency reminders.
- After 4 consecutive large unbounded reads, the next one is **blocked** — forcing the agent to use IDE search tools or bounded reads.
- Uses a 5-minute cooldown between reminders to avoid spam.

### Non-symbolic exploration streak blocking

Tracks mixed non-symbolic tool usage (`grep`, `read` unbounded, `bash` with `rg`/`grep`/`find`):

- Each non-symbolic call increments a streak counter.
- Using any semantic IDE tool (`ide_find_*`, `ide_search_text`, `ide_refactor_rename`, etc.) resets the streak to zero.
- Once the streak threshold (6 weighted calls) is reached, the next non-symbolic call is **blocked** with a 2-minute cooldown.

### Move-refactor nudges

Detects `mv` / `git mv` in bash commands and injects a reminder to prefer `ide_move_file` so imports and references are updated automatically.

### Session-start nudge

On the first turn after activation, injects a one-time nudge: *prefer IDE semantic tools first, start with `ide_find_file`, `ide_search_text`, `ide_find_definition`, `ide_find_references`.*

## Architecture

```
jetbrains-index.ts     ← entry point, hooks pi events
├── prompts.ts          ← system prompt / reminder builders
├── diagnostics.ts      ← diagnostics summary formatting
├── problems-tracker.ts ← baseline capture + new-problem diffing
├── mcp-problems-client.ts ← MCP transport (connect/retry/reconnect)
├── capabilities.ts     ← detect available IDE tools
├── constants.ts        ← thresholds, cooldowns, regexes
├── tool-names.ts       ← tool name resolution (direct + proxy)
└── types.ts            ← shared type definitions
```

## Configuration

The extension is configured through its [docs index](docs/ai-index.json). Key thresholds (in `constants.ts`) can be reviewed there:

| Constant | Default | Purpose |
|---|---|---|
| `LARGE_READ_LINE_THRESHOLD` | 200 | Lines above which a read is considered "large" |
| `LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD` | 4 | Consecutive large reads before blocking |
| `NON_SYMBOLIC_STREAK_BLOCK_THRESHOLD` | 6 | Weighted non-symbolic calls before blocking |
| `NON_SYMBOLIC_DENY_COOLDOWN_MS` | 120s | Cooldown between streak-block actions |
| `NUDGE_COOLDOWN_MS` | 5m | Cooldown between read/move reminders |
| `IDE_INDEX_STATUS_MAX_RETRIES` | 3 | Index readiness retries before session disable |
| `IDE_INDEX_STATUS_RETRY_DELAY_MS` | 5s | Delay between index readiness retries |
| `MCP_TOOL_CALL_TIMEOUT_MS` | 30s | Timeout for a single MCP tool call |

## Troubleshooting

- **No guardrails activating?** Make sure `.idea/` exists in the working directory and the `jetbrains-index` MCP server is running.
- **"Extension disabled for this session"?** The IDE was in dumb mode for too long or MCP connection failed. Restart the pi session after the IDE finishes indexing.
- **Diagnostics not showing?** The extension only reports *new* issues introduced by the edit. Pre-existing problems are filtered out via baseline capture.

## Build / typecheck

```bash
# from monorepo root
npm run typecheck
```

## Version bump & publish

```bash
cd packages/jetbrains-index
npm version patch
npm publish --access public
```

## License

MIT
