# @ineersa/my-pi-subagents

> **Subagent orchestration for [Pi coding agent](https://github.com/badlogic/pi-mono).**
> Single & parallel foreground execution · agent discovery · skill injection · model fallback · recursion guard.

[![npm](https://img.shields.io/npm/v/@ineersa/my-pi-subagents)](https://www.npmjs.com/package/@ineersa/my-pi-subagents)
[![license](https://img.shields.io/npm/l/@ineersa/my-pi-subagents)](LICENSE)

---

## Origin

This package is a **full rewrite** based on [pi-subagents](https://www.npmjs.com/package/pi-subagents) by Nico Bailon.
The original concept, agent-discovery patterns, and skill-injection design informed this implementation.
See [LICENSE](LICENSE) for copyright details.

## What's included

- **Single foreground subagent runs** — delegate a task to a named agent
- **Parallel foreground runs** — fan out tasks across agents with concurrency control
- **Agent discovery** — auto-discover agents from `~/.agents`, `~/.pi/agent/agents`, `.pi/agents`, `.agents`
- **Skill injection** — inject skills into subagent sessions
- **Model fallback** — configurable fallback when the requested model is unavailable
- **Recursion guard** — prevents runaway subagent nesting
- **Artifact & session capture** — capture subagent output for downstream use

## Install

```bash
# via the my-pi installer
npx @ineersa/my-pi --yes

# or directly with pi
pi install @ineersa/my-pi-subagents
```

## Tool

Registers one tool: `subagent`

Supported modes:

- **single**: `{ agent, task }`
- **parallel**: `{ tasks: [{ agent, task, count? }, ...], concurrency? }`

Optional controls: `context`, `cwd`, `agentScope`, `artifacts`, `includeProgress`, `share`, `sessionDir`, `output`, `skill`, `model`

## Config

```text
~/.pi/agent/extensions/subagent/config.json
```

Supported keys:

- `defaultSessionDir`
- `maxSubagentDepth`
- `parallel.maxTasks`
- `parallel.concurrency`

## Docs

- [`docs/ai-index.json`](docs/ai-index.json)
- [`docs/extensions/subagent/settings.md`](docs/extensions/subagent/settings.md)
- [`docs/extensions/subagent/usage.md`](docs/extensions/subagent/usage.md)
- [`docs/extensions/subagent/maintenance.md`](docs/extensions/subagent/maintenance.md)
