# jetbrains-index maintenance

## Source of truth

Core implementation files:

- `extensions/jetbrains-index/jetbrains-index.ts` — event hooks, guard orchestration, and wrapper tool registration
- `extensions/jetbrains-index/wrappers.ts` — barrel/orchestrator importing per-tool factories and exporting `createAllWrapperTools`
- `extensions/jetbrains-index/tools/types.ts` — shared type definitions (`ToolResult`, `ToolRegistration`, `ExecCtx`, `ContentBlock`)
- `extensions/jetbrains-index/tools/shared.ts` — shared helpers (`callTool`, `resolveAndMerge`, `withMutationLock`, `TargetParams`, metadata helpers)
- `extensions/jetbrains-index/tools/find-file.ts` — `createFindFile` (ide_find_file)
- `extensions/jetbrains-index/tools/search-text.ts` — `createSearchText` (ide_search_text)
- `extensions/jetbrains-index/tools/find-symbol.ts` — `createFindSymbol` (ide_find_symbol)
- `extensions/jetbrains-index/tools/find-definition.ts` — `createDefinition` (ide_find_definition)
- `extensions/jetbrains-index/tools/find-references.ts` — `createReferences` (ide_find_references)
- `extensions/jetbrains-index/tools/rename-symbol.ts` — `createRenameSymbol` (ide_rename_symbol)
- `extensions/jetbrains-index/tools/rename-file.ts` — `createRenameFile` (ide_rename_file)
- `extensions/jetbrains-index/tools/find-implementations.ts` — `createImplementations` (ide_find_implementations)
- `extensions/jetbrains-index/tools/find-super-methods.ts` — `createSuperMethods` (ide_find_super_methods)
- `extensions/jetbrains-index/tools/type-hierarchy.ts` — `createTypeHierarchy` (ide_type_hierarchy)
- `extensions/jetbrains-index/tools/call-hierarchy.ts` — `createCallHierarchy` (ide_call_hierarchy)
- `extensions/jetbrains-index/tools/diagnostics.ts` — `createDiagnostics` (ide_diagnostics)
- `extensions/jetbrains-index/tools/move-file.ts` — `createMoveFile` (ide_move_file)
- `extensions/jetbrains-index/tools/file-structure.ts` — `createFileStructure` (ide_file_structure)
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
  ├─ wrappers.ts                    ← barrel/orchestrator (imports tools/*)
  │    ├─ tools/types.ts            ← shared types (ToolResult, ToolRegistration)
  │    ├─ tools/shared.ts           ← shared helpers (callTool, resolveAndMerge, etc.)
  │    ├─ tools/find-file.ts        ← ide_find_file
  │    ├─ tools/search-text.ts      ← ide_search_text
  │    ├─ tools/find-symbol.ts      ← ide_find_symbol
  │    ├─ tools/find-definition.ts  ← ide_find_definition
  │    ├─ tools/find-references.ts  ← ide_find_references
  │    ├─ tools/rename-symbol.ts    ← ide_rename_symbol
  │    ├─ tools/rename-file.ts      ← ide_rename_file
  │    ├─ tools/find-implementations.ts → ide_find_implementations
  │    ├─ tools/find-super-methods.ts   → ide_find_super_methods
  │    ├─ tools/type-hierarchy.ts   ← ide_type_hierarchy
  │    ├─ tools/call-hierarchy.ts   ← ide_call_hierarchy
  │    ├─ tools/diagnostics.ts      ← ide_diagnostics
  │    ├─ tools/move-file.ts        ← ide_move_file
  │    ├─ tools/file-structure.ts   ← ide_file_structure
  │    └─ tools/
  ├─ target-resolver.ts             ← symbol → file/line/column resolution
  ├─ jetbrains-service.ts           ← MCP client (17-tool catalog, TOON, metadata)
  │    └─ settings-config.ts        ← config loader
  └─ problems-tracker.ts
       └─ jetbrains-service.ts
```

Per-tool files are under `tools/`. Each file owns its registration, schema,
descriptions, and execute logic. Shared helpers and types live in `tools/types.ts`
and `tools/shared.ts`. `wrappers.ts` is a thin barrel that imports all tool
factories and exports `createAllWrapperTools`.

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
- IDE mutation tools (`ide_rename_symbol`, `ide_rename_file`, `ide_move_file`) perform one whole-project sync after success and do **not** run diagnostics.
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
