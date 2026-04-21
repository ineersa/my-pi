---
name: subagents
description: Delegate tasks to specialized subagents using pi-subagents extension. Covers single runs, sequential chains, parallel fan-out, background execution, worktree isolation, and agent management. Use when user asks to run subagents, delegates work to agents, mentions scout/worker/reviewer/researcher, or wants to create/manage agents or chains. Also use when starting or coordinating multi-agent workflows.
---

# Subagents

pi-subagents extension for delegating tasks to specialized agents.

## Quick Reference

```
# Single agent
{ agent: "scout", task: "analyze auth module" }

# Chain (sequential pipeline)
{ chain: [{ agent: "scout", task: "scan codebase" }, { agent: "reviewer", task: "review {previous}" }] }

# Parallel (concurrent agents)
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }] }

# Background
{ agent: "scout", task: "...", clarify: false, async: true }

# Chain with parallel fan-out
{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [{ agent: "worker", task: "Feature A from {previous}" }, { agent: "worker", task: "Feature B from {previous}" }], worktree: true },
  { agent: "reviewer", task: "Review {previous}" }
]}
```

## Available Agents

| Agent | Model | Use for |
|-------|-------|---------|
| **scout** | llama.cpp/flash | Fast codebase recon, compressed context handoff |
| **researcher** | llama.cpp/flash | Web research, multi-source synthesis with citations |
| **reviewer** | (default) + high thinking | Thorough security/correctness/design code review |
| **worker** | (default) | General-purpose, full capabilities, isolated context |
| **browser** | (default) | Browser interaction, screenshots, UI testing via playwright-cli |

Agents live in `~/.agents/*.md`. Project overrides in `.pi/agents/*.md`.

## Key Concepts

- **`systemPromptMode: replace`** (default) — agent gets only its own prompt, clean slate
- **`inheritProjectContext`** — pass project AGENTS.md to child (user agents: off, builtins: on)
- **`context: "fork"`** — child starts from a real branched session of parent's current leaf
- **Chain variables**: `{task}` (original), `{previous}` (prior step output), `{chain_dir}` (artifacts path)
- **`worktree: true`** — each parallel agent gets isolated git worktree (needs clean git state)
- **Model fallback** — set `fallbackModels` in agent frontmatter for auto-retry on provider failure

## Choosing Execution Mode

| Need | Mode | Example |
|------|------|---------|
| One focused task | single | `{ agent: "scout", task: "..." }` |
| Multi-step pipeline | chain | scout → reviewer |
| Independent concurrent work | parallel | 2 scouts scanning different areas |
| Long-running task | async | add `clarify: false, async: true` |
| Filesystem-safe parallel | worktree | `worktree: true` on parallel step |

## Intercom Coordination

When pi-intercom is installed, delegated children get runtime instructions for contacting the orchestrator. Configure in `~/.pi/agent/extensions/subagent/config.json`:

```json
{ "intercomBridge": { "mode": "always" } }
```

Children use `intercom({ action: "ask"|"send", to: "<orchestrator>", message: "..." })`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/run <agent> <task>` | Run single agent |
| `/chain agent1 "task" -> agent2 "task"` | Sequential pipeline |
| `/parallel agent1 "task" -> agent2 "task"` | Concurrent execution |
| `/agents` | Agents Manager overlay (Ctrl+Shift+A) |
| `/subagents-status` | Async status overlay |

Add `--bg` to any command for background execution. Add `--fork` for forked context.

## Management Actions (via tool)

```typescript
{ action: "list" }                           // discover agents + chains
{ action: "get", agent: "scout" }            // inspect one
{ action: "create", config: { name: "...", scope: "user", systemPrompt: "...", ... } }
{ action: "update", agent: "scout", config: { model: "..." } }
{ action: "delete", agent: "scout" }
```

## Deep References

- [PARAMETERS.md](PARAMETERS.md) — tool params, chain/parallel item fields, management config, status tool
- [AGENT-FORMAT.md](AGENT-FORMAT.md) — frontmatter reference, tool/extension semantics, chain files, builtin overrides
- [TUI.md](TUI.md) — clarify TUI keybindings, agents manager overlay screens & shortcuts
- [CONFIG.md](CONFIG.md) — extension config.json, recursion guard, artifacts layout, async observability
