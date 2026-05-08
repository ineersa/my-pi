# subagent usage

Provides one extension entry (`./index.ts`) that registers the `subagent` tool.

## Install

From this workspace:

```bash
pi install /home/ineersa/claw/my-pi/packages/subagents
```

Via the installer package list:

```bash
node packages/my-pi/bin/my-pi.mjs --source local --local --yes --no-scheduler
```

## Execution modes

### Single

```json
{
  "agent": "scout",
  "task": "Analyze the auth flow",
  "context": "fresh"
}
```

### Parallel

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect API routes" },
    { "agent": "worker", "task": "Review tests", "count": 2 }
  ],
  "concurrency": 2
}
```

## Useful overrides

- `skill`: add skills, replace skills, or disable inherited agent skills with `false`
- `model`: force a model for a single run or parallel task
- `output`: save single-run final output to a file
- `includeProgress`: include full progress snapshots in returned `details`
- `artifacts: false`: skip debug artifact capture for that run
- `agentScope`: limit discovery to `user`, `project`, or `both`

## `context: "fork"`

`fork` is now lightweight. It wraps the delegated task with a fork-oriented preamble and tags the result context as `fork`. It does **not** provide the old intercom/background fork behavior.

## Sessions and artifacts

- If `sessionDir` is omitted, child sessions are stored under the configured/default session root.
- Artifact cleanup runs on extension load and per parent session start.
- `output` writes the final single-run text output; artifact files are separate debug files.

## Prompt inheritance

Each spawned child run loads `subagent-prompt-runtime.ts`, which can strip inherited project context and skills from the child system prompt based on agent settings.

## What remains after trimming

- single foreground execution
- parallel foreground execution
- agent discovery from user/project markdown files
- skill injection and model fallback
- recursion-depth guard
