# @ineersa/my-pi-extensions

Personal extension bundle for pi.

## Install

```bash
pi install npm:@ineersa/my-pi-extensions
```

Local dev: `pi install ./packages/extensions -l`

## Included extensions

- **[safe-guard](extensions/safe-guard/README.md)** — permission gate: blocks sudo, asks on destructive commands, writes outside CWD, and sensitive file reads. Persistent allowlists via UI.
- **bg-process** — overrides `bash`; after 15s it asks whether to move long-running commands to background, tracks them via `bg_status`, and sends completion notifications.
- **compact-header** — dense startup header with model/provider/thinking + keybinding cheatsheet.
- **focus-cursor** — replaces editor software cursor with terminal hardware cursor so focus/unfocused cursor states work in split panes.
- **custom-footer** — rich footer with tokens/cost/context/cwd/branch (+ PR probe), plus `/status` overlay.
- **[skill-palette](extensions/skill-palette/README.md)** — `/skill` command palette to queue a skill for the next prompt with fuzzy search + status widget.
- **[rewind](extensions/rewind/README.md)** — automatic git worktree snapshots at every prompt boundary with exact file restoration during `/fork` and `/tree` navigation.
- **session-status** — footer status indicator + `/my-pi` command to verify bundle is loaded.
**[pi-subagents](https://github.com/nicobailon/pi-subagents)** — full-featured subagent extension: single/chain/parallel execution, clarify TUI, model fallback, async, worktrees. Installed separately via `npm run install:subagents`. Builtin agents removed; uses agents from `~/.agents/` and `.pi/agents/`.

## Companion packages

- **[@ineersa/my-pi-scheduler](../scheduler/README.md)** — recurring checks, one-time reminders, and the LLM-callable `schedule_prompt` tool. Installs separately for projects that need scheduled follow-ups.
- **[@ineersa/my-pi-jetbrains-index](../jetbrains-index/README.md)** — standalone JetBrains index diagnostics gate extension with IDE-first guardrails and diagnostics sync.
- **[@ineersa/my-pi-mcp-adapter](../pi-mcp-adapter/README.md)** — standalone MCP adapter: ToolSearch discovery, direct tools, lazy/eager/keep-alive lifecycle, metadata caching.
- **[@ineersa/my-pi-themes](../themes/README.md)** — curated theme pack (catppuccin-mocha, cyberpunk, gruvbox-dark, nord, oh-p-dark, tokyo-night).

## Add a new extension

1. Create a `.ts` file or directory in `extensions/`.
2. Add the entry to `package.json` → `pi.extensions`.
3. `/reload` or restart pi.
