# subagents-lite

A lean subagent extension for [pi-coding-agent](https://github.com/badlogic/pi-mono). Launch predefined agents (scout, researcher, etc.) as isolated subagent runs in interactive tmux panes. Each `launch_subagents` tool call launches exactly one agent; orchestrators can still issue multiple calls in parallel.

## What's included

- **Agent discovery** — builtin agents ship with the extension; users can override or add agents via `~/.agents/`, `~/.pi/agent/agents/`, or `.pi/agents/` (project-local, highest priority).
- **interactive tmux runtime** — subagents run in sidecar tmux panes split from your current pane; multiple concurrent runs stack vertically.
  - panes auto-close once a final report is captured.
  - each pane starts pi with an initial task message so the task kicks off immediately.
  - child subagent sessions keep extensions enabled (safe-guard still works), but scheduler is disabled in child runs via `PI_SUBAGENT_DISABLE_SCHEDULER=1`.
  - child turn completion sends a structured intercom event to the parent session; parent updates run status immediately, even while tmux panes remain open.
  - intercom is required for subagent parent/child communication and is shipped in this extension bundle.
- **One-per-call launch tool** — `launch_subagents` accepts exactly one agent per call. Multiple calls may run concurrently.
- **tmux-native control** — active runs are managed directly in tmux panes (attach, interrupt, kill).
- **LLM tool** — `launch_subagents` tool callable by the model.
  - completion reports are rendered as expandable custom messages (click to expand full subagent replies).
- **Startup inventory** — on session start, shows where agents were loaded from and warns about name conflicts (which source won).

## Commands

- `/run-agent <name> -- <task>` — Launch a single interactive tmux subagent

## Tool: `launch_subagents`

The model can call this tool directly. Parameters:

- `agents` (string[], required) — exactly one agent name to launch (single-item array).
- `task` (string, required) — task description.
- `modelOverride` (string, optional) — override model for the launched agent.
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

- `name` (required) — Unique agent name
- `description` (required) — Short description
- `model` (optional) — Model to use (e.g., `anthropic/claude-haiku-4-5`)
- `tools` (optional) — Comma-separated tool list (supports `mcp:*`, `mcp:<server>`, `mcp:<server>/<tool>`)
- `skills` or `skill` (optional) — Comma-separated skill names (resolved with project/user + package/settings fallback, injected into prompt)
- `thinking` (optional) — Thinking level (off, minimal, low, medium, high, xhigh)

Body markdown = system prompt for the child process.

Skill loading mirrors `pi-subagents`: resolved skills are injected as `<skill name="...">...</skill>` in the child system prompt, and child runtime skill discovery is disabled (`--no-skills`) for deterministic behavior.

## Precedence

When the same agent name exists in multiple sources:

1. **builtin** (shipped with extension) — lowest priority
2. **user** (`~/.agents/` or `~/.pi/agent/agents/`)
3. **project** (`.pi/agents/` in nearest project root) — highest priority

## Limits

- **One launch per tool call** (`launch_subagents` enforces exactly one agent in `agents`)
- **Max 3 concurrent subagents** globally (hard cap to avoid intercom contention and unreadable tmux splits)
- No forced timeout in interactive mode (run ends when pi exits, pane is killed, or you mark done)
- Subagent depth guard: respects `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` env vars
- tmux runtime requires `tmux` available on PATH

## Not included (v1)

- Chain execution / sequential pipelines
- Agent CRUD editor
- Worktree isolation
- Multi-hop orchestration protocols (child → parent only today)
