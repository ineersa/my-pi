# Project Overview

my-pi is a personal extension suite and one-command installer for
[pi-coding-agent](https://github.com/badlogic/pi-mono). It ships five npm
packages — an extension bundle, a standalone scheduler extension, a standalone
JetBrains index diagnostics extension, a theme pack, and an installer CLI — that
add permission gates, scheduled follow-ups, IDE diagnostics guardrails, and a
status indicator to any pi session. The monorepo uses npm workspaces, raw
TypeScript extensions loaded directly by pi, and zero build step.

## Repository Structure

- `packages/extensions/` — pi extension bundle (`@ineersa/my-pi-extensions`)
  with safe-guard (permission gate), rewind (file checkpoints), and session-status (footer widget)
- `packages/scheduler/` — standalone scheduler extension
  (`@ineersa/my-pi-scheduler`): recurring checks, reminders, `schedule_prompt`
  tool; depends on `croner`
- `packages/jetbrains-index/` — standalone JetBrains index diagnostics gate
  (`@ineersa/my-pi-jetbrains-index`): IDE-first tool guidance, edit/write guard,
  and post-write diagnostics sync
- `packages/themes/` — curated theme pack (`@ineersa/my-pi-themes`):
  cyberpunk, nord, gruvbox, tokyo-night, catppuccin, oh-pi-dark
- `packages/my-pi/` — installer CLI (`@ineersa/my-pi`) that registers all
  packages with `pi install` in one command; also sets theme and deploys
  safe-guard policy globally
- `.pi/` — project-local pi settings (settings.json, safe-guard policy);
  git-ignored
- `~/.pi/agent/` — global pi settings (settings.json, safe-guard policy,
  scheduler storage, auth)
- `tsconfig.json` — strict TypeScript config covering all packages; test files
  excluded

## Build & Development Commands

```bash
# install all workspace dependencies
npm install

# type-check every package (no emit)
npm run typecheck

# install extensions into this project's .pi/settings.json (local dev)
npm run install:local

# remove local extensions from .pi/settings.json
npm run remove:local

# install from local workspace paths globally (dev testing before publish)
npm run install:global

# installer help
npm run installer:help

# start pi in this repo (requires global pi)
pi
```

There is no build, lint, or deploy step — pi loads raw `.ts` extension files
at runtime. TypeScript is used only for type-checking.

## Local Development Workflow

Extensions can be loaded **locally** (workspace paths in `.pi/settings.json`) or
**globally** (published npm packages in `~/.pi/agent/settings.json`). Never have
both active at the same time — pi loads both and conflicts on tools/flags.

### Working in this repo (local dev)

```bash
# Remove any global installs first
npx @ineersa/my-pi --remove

# Register local workspace paths in .pi/settings.json
npm run install:local

# Start pi — edits to extensions/ are live after /reload
pi
```

### Working anywhere else (global install)

```bash
# Install published packages globally
npx @ineersa/my-pi

# Make sure no project has .pi/settings.json with local paths
```

### Testing a local change globally (before publishing)

```bash
# Install from workspace paths into global settings
npm run install:global

# Test in any directory
cd /tmp && pi
```

### Publishing updates

```bash
npm version patch -w @ineersa/my-pi-extensions -w @ineersa/my-pi-scheduler -w @ineersa/my-pi-jetbrains-index -w @ineersa/my-pi-themes -w @ineersa/my-pi
npm run publish:all
```

## Code Style & Conventions

- **Language:** TypeScript 5.x, strict mode, ES2022 target, NodeNext modules
- **Formatting:** no project-level formatter configured; follow existing style
  (tabs, 100-char line hint, trailing semicolons)
- **Naming:** `kebab-case` file names, `camelCase` functions, `PascalCase`
  exported types/classes
- **Exports:** each extension entry must `export default function
  <name>Extension(pi: ExtensionAPI): void`
- **Imports:** use `.js` extension in relative imports (NodeNext resolution)
- **Commit messages:** no enforced convention yet

> TODO: add biome or prettier config for consistent formatting

## Architecture Notes

```
┌──────────────────────────────────────────────────────┐
│                    pi-coding-agent                    │
│                                                      │
│  ┌─────────────┐  pi.install()  ┌────────────────┐  │
│  │ my-pi CLI   │───────────────>│ .pi/settings.  │  │
│  │ (installer) │                │    json         │  │
│  └─────────────┘                └───────┬────────┘  │
│                                         │ loads      │
│         ┌───────────────────────────────┘           │
│         ▼                                           │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │ @ineersa/        │  │ @ineersa/                │ │
│  │ my-pi-extensions │  │ my-pi-scheduler          │ │
│  │                  │  │                          │ │
│  │  safe-guard/     │  │  scheduler.ts            │ │
│  │  session-status  │  │  scheduler-parsing.ts    │ │
│  │  rewind          │  │  scheduler-registration  │ │
│  └──────────────────┘  │  scheduler-shared.ts     │ │
│                        └──────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- **safe-guard** hooks `tool_call` events for bash/write/edit/read tools,
  classifies intent, and blocks/asks based on a persistent JSON policy file;
  reads from `.pi/safe-guard.json` (project-local) → `~/.pi/agent/safe-guard.json`
  (global) → built-in defaults
- **rewind** captures git worktree snapshots at every prompt boundary,
  stores metadata in hidden session entries, and offers exact file restoration
  during `/fork` and `/tree` navigation
- **session-status** listens to `session_start`/`session_shutdown` to set a
  status bar label and registers `/my-pi` for a quick health check
- **scheduler** uses a `SchedulerRuntime` singleton that persists tasks to
  `~/.pi/agent/scheduler/<workspace>/scheduler.json`, dispatches prompts via
  `pi.sendUserMessage()` when idle, and manages multi-instance ownership
  through lease files
- **jetbrains-index** injects IDE-first semantic tool guidance, blocks
  `edit`/`write` while JetBrains indexing is in dumb mode, and reports new
  diagnostics after successful file mutations

## Testing Strategy

- **Unit tests:** co-located `*.test.ts` files using vitest (scheduler has
  2,600+ lines of tests covering parsing, runtime, commands, tool actions,
  persistence, and edge cases)
- **Test files are excluded** from `tsconfig.json` and `package.json`
  `files` arrays — they are not shipped to consumers
- **No CI pipeline** configured yet for this repo

> TODO: add `npm test` script and CI workflow; add tests for safe-guard

## Security & Compliance

- **No secrets in code** — all credentials/auth handled by pi core; extensions
  never read tokens or API keys
- **safe-guard** blocks `sudo`, asks before destructive commands, writes
  outside CWD, and reads of sensitive files (`.env.*.local`, `.ssh/id_*`,
  cloud creds, etc.)
- **Scheduler storage** confined to `~/.pi/agent/scheduler/`; no user input
  reaches filesystem paths without sanitization
- **Rate limits:** scheduler caps at 6 dispatches/minute, 50 tasks max,
  3-day recurring expiry
- **Atomic writes:** both scheduler and safe-guard policy use write-to-temp +
  rename
- **License:** MIT (all packages); only runtime dependency is `croner` (MIT)

## Agent Guardrails

- **Never modify** `packages/my-pi/bin/my-pi.mjs` without manual review — it
  executes `pi` via `child_process`
- **Never modify** `package-lock.json` directly — use `npm install <pkg>`
- **Never commit** `.pi/` contents (git-ignored; contains local settings and
  safe-guard policy)
- **Never add** `node_modules` references in imports — use package names or
  relative `.js` paths only
- **New extensions** must be added to both the extension directory **and**
  `package.json → pi.extensions` array
- **New packages** must be added to `packages/my-pi/bin/package-list.mjs`
- **TypeScript errors in test files** are expected (vitest not a workspace
  dependency); only `npm run typecheck` output matters

## Extensibility Hooks

- **Adding an extension:** create `.ts` file or directory under
  `packages/extensions/extensions/`, add entry to that package's
  `pi.extensions` array, then `/reload` or restart pi
- **Adding a package:** create new dir under `packages/` with its own
  `package.json` (must include `"pi": { "extensions": [...] }`), then add it
  to `INSTALLER_PACKAGES` in `packages/my-pi/bin/package-list.mjs`
- **Safe-guard policy:** reads `.pi/safe-guard.json` (project-local) first, then
  `~/.pi/agent/safe-guard.json` (global fallback), then built-in defaults;
  `npx @ineersa/my-pi` deploys a default global policy
- **Scheduler scope:** tasks default to `instance` scope; use `--workspace`
  flag or `scope: "workspace"` tool param for cross-instance monitors
- **pi event bus:** extensions can emit custom events via `pi.events.on()`
  (e.g., `oh-pi:safe-mode`)

## Tool Preferences

When working with this codebase:

- **Prefer JetBrains IDE index MCP tools** (`jetbrains_index_ide_*`) for semantic code operations:
  - Finding usages/references: use `jetbrains_index_ide_find_references` instead of grep
  - Going to definition: use `jetbrains_index_ide_find_definition` instead of text search
  - Finding classes/files: use `jetbrains_index_ide_find_class` and `jetbrains_index_ide_find_file`
  - Searching exact words: use `jetbrains_index_ide_search_text` (use grep only for regex)
  - Renaming symbols: use `jetbrains_index_ide_refactor_rename` instead of edit/sed replacements
  - Moving code files: use `jetbrains_index_ide_move_file` instead of `mv`/`git mv`
  - Hierarchy/call flow: use `jetbrains_index_ide_type_hierarchy`, `jetbrains_index_ide_call_hierarchy`, `jetbrains_index_ide_find_implementations`, `jetbrains_index_ide_find_super_methods`
  - Diagnostics/index/sync: use `jetbrains_index_ide_diagnostics`, `jetbrains_index_ide_index_status`, `jetbrains_index_ide_sync_files`
- If IDE tools fail unexpectedly or results seem incomplete, check `jetbrains_index_ide_index_status`
- After creating/modifying files with `edit`/`write`, run `jetbrains_index_ide_sync_files` on changed paths before retrying IDE queries
- Use project-relative file paths and 1-based `line`/`column` for IDE tool calls
- These tools are faster, more context-efficient, and better integrated with the IDE than the default tools
- Only fall back to default tools when IDE tools do not support the needed operation (e.g., regex search)

## Further Reading

- [Root README](README.md) — quick start and project layout
- [Extensions README](packages/extensions/README.md) — bundle contents and
  how to add extensions
- [Safe-guard README](packages/extensions/extensions/safe-guard/README.md) —
  permission rules, policy file format, commands
- [Rewind README](packages/extensions/extensions/rewind/README.md) —
  file snapshots, restore options, retention, configuration
- [Scheduler README](packages/scheduler/README.md) — commands, tool API,
  ownership model, limits
- [JetBrains Index README](packages/jetbrains-index/README.md) — diagnostics
  gate behavior and package usage
- [Installer README](packages/my-pi/README.md) — CLI options and package
  table
