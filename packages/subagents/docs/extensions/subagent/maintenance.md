# subagent maintenance

Entry: `index.ts`

## Safety checks before install

- `package.json` must list only existing extension entries in `pi.extensions`
- `package.json pi.skills[]` must point at the bundled `./skills` directory when the package ships installable skills
- `package.json files[]` must include `docs` and `skills` when those assets are shipped
- `docs/ai-index.json` must match package name, version, and extension entry
- `schemas.ts` and the tool description in `index.ts` must describe the same modes/options

## Validation checklist

Run:

```bash
npm run typecheck
npm run docs:check
npm pack --dry-run ./packages/subagents
node packages/my-pi/bin/my-pi.mjs --source local --local --yes --no-scheduler
```

Expected state:

- no non-TS5097 TypeScript errors in `packages/subagents/`
- docs validation passes
- packed file list contains `index.ts`, runtime `.ts` files, `README.md`, `docs/`, and `skills/` when bundled skills are expected
- installer can register `packages/subagents`

## Runtime surface

Current extension behavior is intentionally small:

- registers the `subagent` tool
- listens to `session_start` to reset state and clean old artifacts
- listens to `session_shutdown` to clear cleanup timers
- spawns foreground child pi runs only

## High-risk areas when editing

- `subagent-executor.ts` — mode validation, task normalization, result shaping
- `execution.ts` — child process spawning, streaming updates, artifact/session writes
- `pi-args.ts` + `subagent-prompt-runtime.ts` — child prompt inheritance rules
- `agents.ts` + `skills.ts` — discovery precedence and override behavior

## When behavior changes

Update all of the following together:

- `schemas.ts`
- `index.ts` tool description
- `docs/extensions/subagent/*.md`
- `docs/ai-index.json`
- `package.json` (`pi.extensions`, `files`, dependencies if runtime imports changed)

## Install-safety notes

This trimmed package no longer depends on removed files such as `notify.ts`, `install.mjs`, `slash-commands.ts`, `worktree.ts`, or `agents/`. If any of those reappear in imports, packaging or installation should be treated as unsafe until revalidated.
