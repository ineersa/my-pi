# subagents-lite

A lean subagent extension for [pi-coding-agent](https://github.com/badlogic/pi-mono). Launch predefined agents (scout, researcher, etc.) as isolated subagent runs, individually or in parallel (up to 4), with interactive tmux panes.

## What's included

- **Agent discovery** — builtin agents ship with the extension; users can override or add agents via `~/.agents/`, `~/.pi/agent/agents/`, or `.pi/agents/` (project-local, highest priority).
- **interactive tmux runtime** — subagents run in sidecar tmux panes split from your current pane; parallel runs stack vertically (up to 4).
  - panes auto-close once a final report is captured.
  - each pane starts pi with an initial task message so the task kicks off immediately.
  - child subagent sessions keep extensions enabled (safe-guard still works), but scheduler is disabled in child runs via `PI_SUBAGENT_DISABLE_SCHEDULER=1`.
  - child turn completion sends a structured intercom event to the parent session; parent updates run status immediately, even while tmux panes remain open.
  - intercom is required for subagent parent/child communication and is shipped in this extension bundle.
- **Parallel launch** — run up to 4 subagents concurrently, including duplicates (e.g., 3 scouts).
- **Status overlay** — `/subagents-status` shows active and recent runs, supports pane jump + control.
  - includes per-step skill diagnostics (`cfg / ok / missing`) for quick debugging.
  - jump into a running pane with `enter`/`j` from status (`k` interrupt, `shift+k` kill pane, `m` mark done, `esc` close).
- **LLM tool** — `launch_subagents` tool callable by the model.
- **Startup inventory** — on session start, shows where agents were loaded from and warns about name conflicts (which source won).

## Commands

| Command | Description |
|---|---|
| `/run-agent <name> -- <task>` | Launch a single interactive tmux subagent |
| `/subagents-status` | Show active + recent run history |
| `Ctrl+Alt+S` | Open subagents status overlay |

## Tool: `launch_subagents`

The model can call this tool directly. Parameters:

- `agents` (string[], required) — agent names to launch. Duplicates allowed. Max 4.
- `task` (string, required) — task description.
- `modelOverride` (string, optional) — override model for all agents.
- `cwd` (string, optional) — working directory.

## Agent file format

Agents are `.md` files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, bash
model: anthropic/claude-haiku-4-5
skills: my-skill
thinking: high
---

System prompt body goes here.
```

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique agent name |
| `description` | Yes | Short description |
| `model` | No | Model to use (e.g., `anthropic/claude-haiku-4-5`) |
| `tools` | No | Comma-separated tool list (supports `mcp:*`, `mcp:<server>`, `mcp:<server>/<tool>`) |
| `skills` or `skill` | No | Comma-separated skill names (resolved with project/user + package/settings fallback, injected into prompt) |
| `thinking` | No | Thinking level (off, minimal, low, medium, high, xhigh) |

Body markdown = system prompt for the child process.

Skill loading mirrors `pi-subagents`: resolved skills are injected as `<skill name="...">...</skill>` in the child system prompt, and child runtime skill discovery is disabled (`--no-skills`) for deterministic behavior.

## Precedence

When the same agent name exists in multiple sources:

1. **builtin** (shipped with extension) — lowest priority
2. **user** (`~/.agents/` or `~/.pi/agent/agents/`)
3. **project** (`.pi/agents/` in nearest project root) — highest priority

## Limits

- **Max 4 concurrent launches** per call (hard cap)
- No forced timeout in interactive mode (run ends when pi exits, pane is killed, or you mark done)
- Subagent depth guard: respects `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` env vars
- tmux runtime requires `tmux` available on PATH

## Not included (v1)

- Chain execution / sequential pipelines
- Agent CRUD editor
- Worktree isolation
- Multi-hop orchestration protocols (child → parent only today)
