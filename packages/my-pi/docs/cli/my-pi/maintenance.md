# my-pi maintenance

## Source files

- CLI entry: `bin/my-pi.mjs`
- Agent/skill sync helper: `bin/sync-agents.mjs`
- Package list input: `bin/package-list.mjs`
- Package docs: `README.md`

## Update checklist

When changing installer behavior:

1. Keep `--help` output aligned with supported flags.
2. Keep README command examples aligned with real options.
3. If package membership changes, update `bin/package-list.mjs`.
4. Treat repo-root `.agents/` as the source of truth; sync `packages/my-pi/.agents/` before packing/publishing.
5. If install defaults change (theme/policy/agents flow), update docs in this folder.

## Guardrails

- Do **not** change behavior in `bin/my-pi.mjs` casually; this script executes `pi` and can modify global user config.
- Keep global writes explicit and scoped (`~/.pi/agent`, `~/.agents`).
- Preserve non-interactive safety (`--yes` and non-TTY fallback) when refactoring prompts.
