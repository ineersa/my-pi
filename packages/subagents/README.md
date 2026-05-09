# pi-subagents

Trimmed subagent extension for Pi.

This fork keeps the parts used in `my-pi`:

- single foreground subagent runs
- parallel foreground subagent runs
- agent discovery from user/project markdown files
- skill injection and model fallback
- recursion-depth guard
- artifact/session capture
- bundled `subagents` skill docs for Pi skill discovery/install

Removed from this package:

- chain execution
- async/background runs
- slash commands
- agent management UI / CRUD
- worktree isolation
- intercom / prompt-template bridge

## Install

### From this monorepo

```bash
pi install /home/ineersa/claw/my-pi/packages/subagents
```

### Via the installer

```bash
node packages/my-pi/bin/my-pi.mjs --source local --local --yes --no-scheduler
```

## Tool

This package registers one tool: `subagent`

Supported modes:

- single: `{ agent, task }`
- parallel: `{ tasks: [{ agent, task, count? }, ...], concurrency? }`

Optional controls include:

- `context`
- `cwd`
- `agentScope`
- `artifacts`
- `includeProgress`
- `share`
- `sessionDir`
- `output`
- `skill`
- `model`

## Agent discovery

User agents:

- `~/.agents`
- `~/.pi/agent/agents`

Project agents:

- `.pi/agents`
- legacy `.agents`

Project agents override user agents by name.

## Config

Config file:

```text
~/.pi/agent/extensions/subagent/config.json
```

Supported keys:

- `defaultSessionDir`
- `maxSubagentDepth`
- `parallel.maxTasks`
- `parallel.concurrency`

## Docs

- `docs/ai-index.json`
- `docs/extensions/subagent/settings.md`
- `docs/extensions/subagent/usage.md`
- `docs/extensions/subagent/maintenance.md`
- `skills/subagents/`

## Validation

```bash
npm run typecheck
npm pack --dry-run ./packages/subagents
pi install /home/ineersa/claw/my-pi/packages/subagents
```

## Origin

Based on `pi-subagents` by Nico Bailon, then reduced for `my-pi`.
