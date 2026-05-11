# AGENTS.md

## Description

`my-pi` is a monorepo for a personal extension suite and installer for
[pi-coding-agent](https://github.com/badlogic/pi-mono). It provides five npm
packages: extension bundle, scheduler, JetBrains index guard, themes, and a
one-command installer. Runtime is zero-build: pi loads raw TypeScript files.

## Repository Structure Overview

- `packages/extensions/` — bundled extensions (`safe-guard`, `rewind`, `session-status`)
- `packages/scheduler/` — standalone scheduler (`schedule_prompt`, recurring checks)
- `packages/jetbrains-index/` — IDE-index-aware diagnostics/edit guard extension
- `packages/themes/` — curated theme pack
- `packages/my-pi/` — installer CLI that registers all packages
- `.pi/` — local project pi config (git-ignored)
- `~/.pi/agent/` — global pi config, scheduler storage, policy files
- `tsconfig.json` — strict typecheck config for workspaces

## Architecture Brief

Core runtime model:
- pi loads extension entrypoints directly from package paths (no build output).
- Installer writes extension registrations into either project-local `.pi/settings.json`
  (local dev) or global `~/.pi/agent/settings.json` (published/global mode).
- Local and global installs must not be active together to avoid duplicate tools/hooks.

Package responsibilities:
- `packages/my-pi` (installer CLI): registers/removes package extensions,
  supports one-command bootstrap, and deploys default safe-guard policy.
- `packages/extensions` (bundle):
  - `safe-guard`: policy-driven command/file safety gate (`allow/ask/block`).
  - `bg-process`: long-running bash backgrounding + per-session process cleanup.
  - `compact-header`: compact header with MCP/subagent-aware runtime indicators.
  - `focus-cursor`: switches editor rendering to hardware cursor mode for focus-aware terminal cursor states.
  - `custom-footer`: rich footer (model/usage/git/PR probe) with throttled probes.
  - `skill-palette`: discovers skills/themes and renders skill-context UI.
  - `rewind`: git-based checkpoint snapshots + deterministic restore flows.
  - `session-status`: minimal session lifecycle status utility.
  - `usage`: provider usage/rate-limit probe with timeout + graceful degradation.
  - `output-cap`: captures large tool outputs to files and avoids response bloat.
  - `subagents`: trimmed subagent extension from `packages/subagents` (single + parallel foreground execution, agent discovery, skill injection, model fallback, recursion guard).
  - `prompt-channels`: relocates AGENTS/project-context and skills registry from system prompt to user-level custom messages.
- `packages/scheduler` (standalone): `schedule_prompt`, natural-language schedules,
  persisted tasks, idle dispatch, and multi-instance ownership/lease coordination.
- `packages/jetbrains-index` (standalone): IDE-first guidance, dumb-mode edit/write
  blocking, changed-path sync, and post-mutation diagnostics.
- `packages/pi-mcp-adapter` (standalone): MCP lifecycle/proxy/direct-tools bridge from `mcp.json`.
- `packages/themes`: curated presentation-only themes, independent from extension runtime.

### Extension docs map

| Extension | Docs |
| --- | --- |
| safe-guard | [settings](packages/extensions/docs/extensions/safe-guard/settings.md) · [maintenance](packages/extensions/docs/extensions/safe-guard/maintenance.md) |
| bg-process | [settings](packages/extensions/docs/extensions/bg-process/settings.md) · [maintenance](packages/extensions/docs/extensions/bg-process/maintenance.md) |
| compact-header | [settings](packages/extensions/docs/extensions/compact-header/settings.md) · [maintenance](packages/extensions/docs/extensions/compact-header/maintenance.md) |
| focus-cursor | [settings](packages/extensions/docs/extensions/focus-cursor/settings.md) · [maintenance](packages/extensions/docs/extensions/focus-cursor/maintenance.md) |
| custom-footer | [settings](packages/extensions/docs/extensions/custom-footer/settings.md) · [maintenance](packages/extensions/docs/extensions/custom-footer/maintenance.md) |
| skill-palette | [settings](packages/extensions/docs/extensions/skill-palette/settings.md) · [maintenance](packages/extensions/docs/extensions/skill-palette/maintenance.md) |
| rewind | [settings](packages/extensions/docs/extensions/rewind/settings.md) · [maintenance](packages/extensions/docs/extensions/rewind/maintenance.md) |
| session-status | [settings](packages/extensions/docs/extensions/session-status/settings.md) · [maintenance](packages/extensions/docs/extensions/session-status/maintenance.md) |
| usage | [settings](packages/extensions/docs/extensions/usage/settings.md) · [maintenance](packages/extensions/docs/extensions/usage/maintenance.md) |
| output-cap | [settings](packages/extensions/docs/extensions/output-cap/settings.md) · [maintenance](packages/extensions/docs/extensions/output-cap/maintenance.md) |
| pi-mcp-adapter | [settings](packages/pi-mcp-adapter/docs/extensions/pi-mcp-adapter/settings.md) · [maintenance](packages/pi-mcp-adapter/docs/extensions/pi-mcp-adapter/maintenance.md) |
| prompt-channels | [settings](packages/extensions/docs/extensions/prompt-channels/settings.md) · [maintenance](packages/extensions/docs/extensions/prompt-channels/maintenance.md) |
| scheduler | [settings](packages/scheduler/docs/extensions/scheduler/settings.md) · [maintenance](packages/scheduler/docs/extensions/scheduler/maintenance.md) |
| schedule_prompt (tool) | [settings](packages/scheduler/docs/tools/schedule_prompt/settings.md) · [maintenance](packages/scheduler/docs/tools/schedule_prompt/maintenance.md) |
| jetbrains-index | [settings](packages/jetbrains-index/docs/extensions/jetbrains-index/settings.md) · [maintenance](packages/jetbrains-index/docs/extensions/jetbrains-index/maintenance.md) |
| subagent | [settings](packages/subagents/docs/extensions/subagent/settings.md) · [maintenance](packages/subagents/docs/extensions/subagent/maintenance.md) |

## How to Run Things

```bash
# install deps
npm install

# typecheck all packages (no emit)
npm run typecheck

# local dev: install local workspace extensions into .pi/settings.json
npm run install:local

# remove local registration
npm run remove:local

# test workspace packages as global install
npm run install:global

# installer help
npm run installer:help

# start pi in this repo
pi
```

Local dev flow:
1. `npx @ineersa/my-pi --remove` (clear global install)
2. `npm run install:local`
3. run `pi` and `/reload` after extension edits

## Rules

- Do not modify `packages/my-pi/bin/my-pi.mjs` without manual review.
- Do not edit `package-lock.json` manually; use `npm install`.
- Never commit `.pi/` contents.
- Keep imports package-based or relative with `.js` extension (NodeNext).
- New extension entries must also be added to the owning package `pi.extensions`.
- New packages must be added to `packages/my-pi/bin/package-list.mjs`.
- Tests may have TS errors locally; `npm run typecheck` is the source of truth.
- Before changing extension behavior, read that package’s docs index:
  `packages/<pkg>/docs/ai-index.json`, then only the referenced
  `settings.md` + `maintenance.md`.
- Each extension/package may include its own local `AGENTS.md` for focused
  architecture notes and development guardrails; keep those aligned with
  the package’s `ai-index.json` docs map.

## References

- [Root README](README.md) (quick start and workspace overview)
- [Extensions README](packages/extensions/README.md)
- [Scheduler README](packages/scheduler/README.md)
- [JetBrains Index README](packages/jetbrains-index/README.md)
- [Themes README](packages/themes/README.md)
- [Installer README](packages/my-pi/README.md)
- [Subagents README](packages/subagents/README.md)
- Package docs indexes:
  - [Extensions ai-index](packages/extensions/docs/ai-index.json)
  - [Scheduler ai-index](packages/scheduler/docs/ai-index.json)
  - [JetBrains Index ai-index](packages/jetbrains-index/docs/ai-index.json)
  - [Subagents ai-index](packages/subagents/docs/ai-index.json)

