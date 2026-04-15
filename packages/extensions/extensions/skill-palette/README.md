# skill-palette

Adapted from [`nicobailon/pi-skill-palette`](https://github.com/nicobailon/pi-skill-palette) for `@ineersa/my-pi-extensions`.

Interactive `/skill` command palette for selecting one skill to inject into your **next** prompt.

## What it does

- Adds `/skill` command with fuzzy search.
- Queues one selected skill at a time.
- Shows queued skill in status + widget.
- Injects selected skill as a custom `skill-context` message on next turn.
- Supports unqueue with confirmation dialog.

## Skill discovery order

1. `~/.codex/skills/` (recursive)
2. `~/.claude/skills/` (one level deep)
3. `${cwd}/.claude/skills/` (one level deep)
4. `~/.agents/skills/` (recursive)
5. `${cwd}/.agents/skills/` (recursive)
6. `~/.opencode/skills/` (recursive)
7. `${cwd}/.opencode/skills/` (recursive)
8. `~/.pi/agent/skills/` (recursive)
9. `~/.pi/skills/` (recursive)
10. `${cwd}/.pi/skills/` (recursive)

Each skill must contain `SKILL.md` with frontmatter `name` + `description`.

## Theme config (optional)

Create `theme.json` next to `index.ts` in this folder. You can start from `theme.example.json`.

Fallback legacy path still supported:

- `~/.pi/agent/extensions/pi-skill-palette/theme.json`

## Safety notes

- No shell execution (`spawn`/`exec`) and no network calls.
- Read-only filesystem usage for scanning skill dirs + reading `SKILL.md` and optional theme config.
- No file writes, deletions, chmod/chown, or process control.
- Injected skill content comes from local skill files; only trust skill directories you control.
