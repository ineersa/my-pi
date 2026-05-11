# jetbrains-index maintenance

## Source of truth

Core implementation files:

- `extensions/jetbrains-index/jetbrains-index.ts` — event hooks, guard orchestration, and wrapper tool registration
- `extensions/jetbrains-index/wrappers.ts` — first-class Pi wrapper tool definitions (13 tools) backed by JetBrainsService and target-resolver
- `extensions/jetbrains-index/jetbrains-service.ts` — generic JetBrains MCP service layer (transport, catalog, retries, TOON helpers, MCP tool metadata)
- `extensions/jetbrains-index/target-resolver.ts` — target-resolution layer: resolves symbol/location inputs to canonical file/line/column for semantic wrapper tools
- `extensions/jetbrains-index/problems-tracker.ts` — pre/post mutation diagnostics lifecycle, uses JetBrainsService
- `extensions/jetbrains-index/settings-config.ts` — loads JetBrains connection config from Pi settings.json (with mcp.json fallback)
- `extensions/jetbrains-index/prompts.ts` — minimal IDE prompt and reminder builders
- `extensions/jetbrains-index/diagnostics.ts` — diagnostics type definitions and formatting
- `extensions/jetbrains-index/constants.ts` — thresholds, cooldowns, retry timings
- `extensions/jetbrains-index/docs/archive/legacy-strict-policy.txt` — archived old strict policy

### Architecture

```
jetbrains-index.ts                 ← entry point, hooks, tool registration
  ├─ wrappers.ts                    ← 13 first-class Pi wrapper tools
  │    ├─ target-resolver.ts        ← symbol → file/line/column resolution
  │    └─ jetbrains-service.ts      ← MCP client (17-tool catalog, TOON, metadata)
  │         └─ settings-config.ts   ← config loader
  └─ problems-tracker.ts
       └─ jetbrains-service.ts
```

Wrapper tools are registered at session start when IDE is available.
Resolver-backed semantic tools use `target-resolver.ts` before calling the
underlying IDE tool. All tools return MCP-native results (TOON text + isError).

## Guardrails to preserve

When updating behavior, keep these invariants intact:

- Extension stays **dormant** if `.idea/` or MCP config is missing.
- When active, IDE/index health is checked **before every tool call**.
- If health check fails after retries, tool is **blocked**, user is **notified**, agent run is **aborted**.
- On `turn_start`, IDE health is checked and the whole project is **synced**.
- Post-mutation diagnostics continue to report only **new** issues (baseline diff) for built-in `edit`/`write`.
- IDE mutation tools (`ide_refactor_rename`, `ide_move_file`) perform one whole-project sync after success and do **not** run diagnostics.
- Diagnostics flow (edit/write): **open file → sync → wait for index → diagnostics**.
- Move-refactor nudge only fires for `mv`/`git mv` targeting files inside CWD.

## What was removed in stage 1

- Strict IDE policy with full task-to-tool mapping (archived in `docs/archive/`).
- Read-efficiency guardrails (unbounded read tracking, large-read blocks).
- Non-symbolic exploration streak blocking.
- Session-start IDE usage nudge.
- System-reminder wrappers around prompts and diagnostics messages.
- Session-disable-on-index-failure behavior (replaced with block + abort + recover model).

## Validation checklist (quick)

1. Start in a workspace **without** `.idea/`:
   - extension should stay **dormant** — no prompt injection, no guards.
2. Start in a workspace **with** `.idea/` and valid JetBrains MCP:
   - extension should announce enabled status.
   - initial whole-project sync should occur.
3. Force dumb/indexing mode during a tool call:
   - tool should be **blocked**, user notified, agent run **aborted**.
4. Run a `mv file` command inside CWD:
   - a one-time move-refactor nudge should appear.
5. Introduce a new code issue via edit:
   - post-edit diagnostics should include new issues summary (plain text, no system-reminder).
6. Force dumb/indexing mode and then fix IDE, type `continue`:
   - extension should **recover** on the next turn without re-activation.

## Release notes guidance

When changing thresholds, cooldowns, tool mappings, or wrapper tool surface:

- `docs/extensions/jetbrains-index/settings.md`
- `docs/extensions/jetbrains-index/usage.md`
- `docs/extensions/jetbrains-index/maintenance.md`
- `docs/ai-index.json`
- `README.md`
- `package.json` (version)
