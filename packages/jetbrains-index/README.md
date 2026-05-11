# @ineersa/my-pi-jetbrains-index

[pi-coding-agent](https://github.com/badlogic/pi-mono) extension that provides **JetBrains IDE index–aware** diagnostics and guard behavior. Injects minimal IDE tool guidance, blocks tools when the IDE/index is unavailable, syncs the project at turn start, and reports newly introduced diagnostics after code edits.

## Mandatory dependency

**[jetbrains-index-mcp-plugin](https://github.com/hechtcarmel/jetbrains-index-mcp-plugin)** must be installed and configured as an MCP server.  
This extension communicates with the JetBrains IDE through that MCP server — without it, the extension stays **dormant** for the session.

## Activation requirements (both must be true)

1. `.idea/` exists in the current working directory (i.e. a JetBrains project is open).
2. A JetBrains index MCP server is configured and reachable (see Configuration below).

If either condition is missing, the extension stays dormant — no prompt injection, no guardrails, no diagnostics.

## Install

```bash
pi install npm:@ineersa/my-pi-jetbrains-index
```

Local dev:

```bash
pi install ./packages/jetbrains-index -l
```

## What it does

### Minimal IDE tool guidance

When active, injects a short prompt guideline:

- Use JetBrains IDE tools for semantic code operations.
- Use them only for targets inside the current working directory.
- If the IDE/index becomes unavailable, stop and wait for the user to fix it and type continue.

### Hard stop on broken IDE/index

Before every tool call, checks IDE/index readiness. If the IDE is in dumb mode or the index is busy after retries:

1. The tool call is **blocked**.
2. The user is notified.
3. The agent run is **aborted**.
4. User fixes the IDE and types `continue`.

The extension remains active and recovers on the next turn.

### Turn-start project sync

On each agent turn start, performs a whole-project sync so the IDE is aware of any external file changes.

### Post-mutation diagnostics

After every successful `edit` or `write`:

1. Opens the file in the IDE.
2. Syncs the changed file path.
3. Waits for index readiness.
4. Runs diagnostics and reports **only newly introduced** issues (not pre-existing ones).

### Move-refactor nudges

Detects `mv` / `git mv` in bash commands targeting files inside the current working directory and reminds the agent to prefer `ide_move_file` so imports/references are updated automatically.

## States

| State | Behavior |
|---|---|
| **Dormant** | No `.idea/` or no healthy JetBrains MCP for `ctx.cwd`. Extension does nothing. |
| **Active** | Health check passed. Prompt injection enabled. Guards active. |
| **Blocked** | IDE/index broken mid-session. Tool blocked, user notified, agent aborted. Recovers on next turn after user fixes IDE and types `continue`. |

## Architecture

```
jetbrains-index.ts       ← entry point, hooks, tool registration
├── wrappers.ts           ← 12 first-class Pi wrapper tools
│   ├── target-resolver.ts  ← symbol → file/line/column resolution
│   └── jetbrains-service.ts  ← MCP client (17-tool catalog, TOON, metadata)
│       └── settings-config.ts  ← config loader (settings.json + fallback)
├── problems-tracker.ts   ← baseline capture + new-problem diffing
├── prompts.ts            ← minimal IDE prompt + reminder builders
├── diagnostics.ts        ← diagnostics summary formatting
├── constants.ts          ← thresholds, cooldowns, regexes
├── capabilities.ts       ← detect available IDE tools (legacy)
└── tool-names.ts         ← tool name resolution (legacy)
```

### Key changes in v0.4.0

- **First-class wrapper tools**: registers 12 Pi tools (`ide_find_file`,
  `ide_search_text`, `ide_find_symbol`, `ide_find_definition`,
  `ide_find_references`, `ide_refactor_rename`, `ide_find_implementations`,
  `ide_find_super_methods`, `ide_type_hierarchy`, `ide_call_hierarchy`,
  `ide_diagnostics`, `ide_move_file`, `ide_file_structure`) on session start
  when IDE is available.
- **Always-TOON results**: MCP payload decoded, actual data returned as TOON text.
  Errors normalized to `{error, isRetryable, hint}` TOON with `isError: true`.
  No `structuredContent`, no escaped JSON nesting.
- **MCP metadata retention**: `JetBrainsService` stores full tool definitions
  from `tools/list`, enabling wrappers to reuse original descriptions.
- **Resolver-backed semantic tools**: all semantic tools share a common
  targeting contract (file+line+column preferred, symbol fallback).
- **Mutation lock**: `ide_refactor_rename` and `ide_move_file` serialize
  IDE-level mutations.
- **Shared targeting guidance**: minimal prompt now includes targeting rules.

### Key changes in v0.3.0

- **Target-resolution layer**: new `target-resolver.ts` resolves symbol or
  location inputs to canonical `{ file, line, column }` targets. Supports PHP
  (strong), Python (strong), TS/JS with fileHint (strong), and bare-symbol
  best-effort for TS/JS, Rust, and Go via `findSymbol`.
- **findSymbol in catalog**: the 17-tool JetBrainsService catalog now includes
  `findSymbol` for symbol search across the codebase.

### Key changes in v0.2.0

- **Generic service layer**: the old `mcp-problems-client.ts` was generalized
  into `JetBrainsService` — covers all JetBrains IDE tools in one catalog.
- **Settings-based config**: connection config now loads from Pi
  `settings.json` (`jetbrainsIndex` key) with fallback to legacy `mcp.json`.
- **TOON helpers**: service exposes `encodeForModel()` / `formatForModel()`
  for token-efficient result encoding (future wrapper tools).
- **Cleaner API**: convenience methods (`waitForIndexReady`, `syncFiles`,
  `openFile`, `getFileDiagnostics`) no longer require explicit project path.

## Configuration

### Connection config (Pi settings.json)

```json
{
  "jetbrainsIndex": {
    "url": "http://127.0.0.1:3000/mcp",
    "headers": {
      "Authorization": "Bearer ${JETBRAINS_TOKEN}"
    }
  }
}
```

The extension reads the `jetbrainsIndex` key from Pi's `settings.json`
(project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`).
Environment variable references in header values (e.g. `${JETBRAINS_TOKEN}`)
are expanded at load time.

**Legacy fallback**: If `settings.json` has no `jetbrainsIndex` key, the
extension also checks `mcpServers.jetbrains-index` in `.pi/mcp.json` and
`~/.pi/agent/mcp.json` (the old mcp.json format) for backward compatibility.

### Built-in constants

| Constant | Default | Purpose |
|---|---|---|
| `IDE_INDEX_STATUS_MAX_RETRIES` | 5 | Index readiness retries before failure |
| `IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS` | 2s | Base delay between retries (exponential backoff) |
| `IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS` | 30s | Maximum delay cap |
| `NUDGE_COOLDOWN_MS` | 5m | Cooldown between move refactor nudges |
| `MCP_TOOL_CALL_TIMEOUT_MS` | 30s | Timeout for a single MCP tool call |

## Troubleshooting

- **Extension not doing anything?** Make sure `.idea/` exists and the
  `jetbrains-index` MCP server is configured and reachable via `settings.json`
  (or legacy `mcp.json`).
- **Tools getting blocked with "IDE/index unavailable"?** The IDE is in dumb
  mode or indexing. Wait for it to finish, or restart the IDE.
- **Agent run stopped mid-turn?** The IDE became unavailable during a tool
  call. Fix the IDE and type `continue` to resume.

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
