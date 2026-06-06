---
name: subagents
description: Delegate tasks to specialized subagents using pi-subagents extension. Covers single and parallel foreground execution. Use when user asks to run subagents, delegates work to agents, mentions scout/reviewer/researcher, or wants to run parallel agent tasks.
---

# Subagents

Trimmed pi-subagents extension for delegating tasks to specialized agents.

## Quick Reference

```
# Single agent
{ agent: "scout", task: "analyze auth module" }

# Parallel (concurrent agents)
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }] }
```

## Available Agents

| Agent | Model | Use for |
|-------|-------|---------|
| **scout** | deepseek/deepseek-v4-flash | Fast codebase recon, compressed context handoff |
| **reviewer** | (default) + high thinking | Thorough security/correctness/design code review |

User agents in `~/.agents/*.md` or `~/.pi/agent/agents/*.md`. Project agents in `.pi/agents/*.md` or `.agents/*.md` (project wins on name collision). Custom agents follow the same frontmatter + markdown body format.

## Key Concepts

- **`systemPromptMode`**: `replace` (default for most agents, clean slate) or `append` (used by `delegate`)
- **`inheritProjectContext`**: pass project AGENTS.md to child (user agents default off, `delegate` defaults on)
- **`context: "fresh"`** (default): child gets a task-only prompt, no parent session
- **`context: "fork"`**: wraps task with a fork-oriented preamble and tags result context as `fork` — lightweight, no real session branching
- **Model fallback**: set `fallbackModels` in agent frontmatter for auto-retry on provider failure
- **Recursion guard**: `maxSubagentDepth` default 2, per-agent can tighten, env `PI_SUBAGENT_MAX_DEPTH` wins

## Choosing Execution Mode

| Need | Mode | Example |
|------|------|---------|
| One focused task | single | `{ agent: "scout", task: "..." }` |
| Independent concurrent work | parallel | `{ tasks: [{ agent: "scout", task: "..." }, { agent: "scout", task: "..." }] }` |

Only single and parallel foreground execution are supported. There is no chain, async/background, worktree, or intercom mode.

## MCP Access

MCP tool access is controlled via the `tools` frontmatter field in agent markdown files:

| `tools` entry | Effect |
|---------------|--------|
| No `mcp:` entries | Only explicitly listed builtin tools; no MCP or ToolSearch |
| `mcp:*` | Listed builtins + ToolSearch + configured direct MCP tools available |
| `mcp:server__tool` | Listed builtins + only those specific MCP tools (e.g. `mcp:websearch__search`) |

When MCP is enabled via `mcp:*` or specific entries, the child session auto-loads `pi-mcp-adapter` even if `extensions: []` is set.

## Deterministic Child Result

Every subagent child process writes a JSON result artifact to disk before exiting. The parent reads this artifact as the authoritative result. If the artifact is missing, the run is classified as failed regardless of process exit code.

This replaces the old heuristic error detection (keyword scanning of assistant text). The result includes: `task`, `exitCode`, `messages`, `usage`, `model`, `provider`, `stopReason`.

## Deep References

- [PARAMETERS.md](PARAMETERS.md) — tool parameters and parallel task shape
- [AGENT-FORMAT.md](AGENT-FORMAT.md) — frontmatter reference, tool/extension/MCP semantics
- [CONFIG.md](CONFIG.md) — extension config.json, recursion guard, artifacts
