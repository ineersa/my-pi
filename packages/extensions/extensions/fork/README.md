# Pi Fork

Interactive tmux-based fork tool for Pi. Spawns a visible child Pi session in a
right-side tmux pane, auto-exits on completion, and returns dense result summaries
without polluting the parent context window.

Originally created in [`elpapi42/pi-fork`](https://github.com/elpapi42/pi-fork).
This copy is vendored into `@ineersa/my-pi-extensions` for installation through
this workspace.

## Installation

Install this workspace extension bundle, then start or restart Pi. The bundled
extension registers the `fork` tool for use in your Pi sessions.

## Tool

`pi-fork` provides one tool named `fork`:

```
fork({ task: string, model?: string, thinking?: string, background?: boolean })
```

Parameters:

- **`task`** (required): The delegated task. The fork reports back to the parent with dense, concrete output — snippets, signatures, relationships, and anything discovered beyond the task scope. The fork is instructed to ignore user-facing output formatting and produce a structured handoff report.
- **`model`** (optional): Override the model/provider for this specific fork child (e.g. `"anthropic/claude-sonnet-4"`). Overrides the `pi-fork.defaultModel` config.
- **`thinking`** (optional): Override thinking level for this specific fork child. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Overrides the `pi-fork.defaultThinking` config.
- **`background`** (optional): If `true`, launch the fork and return immediately without waiting. A follow-up message is delivered automatically when the fork completes. Useful for long-running tasks that should not block the parent.

## Modes

### Wait mode (default)

Blocks the parent until the fork completes. The tmux pane is auto-closed and the parsed result is returned as tool output.

### Background mode

Set `background: true` to fire-and-forget. Returns immediately with a run ID. A `[FORK_DONE]` follow-up is sent when the fork finishes or fails.

## Context Shape

For a forked child, the LLM context is roughly:

```text
System:
  Normal Pi system prompt
  + FORK child system prompt (fork rules)

Messages:
  Current active branch rebuilt from session.jsonl (fork snapshot sanitization strips parent fork tool calls)
  User: (the task wrapped in handoff report template)
```

The child runs a normal interactive Pi session in a tmux pane. When `PI_FORK=1` is detected, the extension installs auto-exit hooks (`agent_end` → write `result.json` + `process.exit(0)`).

## Configuration

Settings live under `"pi-fork"` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

### Child extension loading

```json
{
  "pi-fork": {
    "extensions": null
  }
}
```

`extensions` is tri-state:

- `null` or omitted: load normal Pi extensions from settings and auto-discovery.
- `[]`: load no extensions in fork children.
- non-empty array: load only those extension sources in fork children.

Example:

```json
{
  "pi-fork": {
    "extensions": ["npm:pi-claude-bridge"]
  }
}
```

Local extension paths are resolved relative to the settings file directory:
`~/.pi/agent` for global settings and `.pi` for project settings.

If `pi-fork` itself is listed in `pi-fork.extensions`, child processes will load
the extension too, but `PI_FORK=1` disables child-side registration of the `fork` tool.

### Default model and thinking

```json
{
  "pi-fork": {
    "defaultModel": "anthropic/claude-sonnet-4",
    "defaultThinking": "medium"
  }
}
```

- `defaultModel`: model/provider string for all fork children (unless overridden per-call via the `model` tool parameter).
- `defaultThinking`: thinking level for fork children. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

### Fork Environment

```json
{
  "pi-fork": {
    "environment": {
      "MY_EXTENSION_MODE": "fork",
      "SERVICE_BASE_URL": "https://example.test"
    }
  }
}
```

Fork children inherit the parent Pi process environment. The resolved
`environment` map is overlaid on top, so configured variables add or override
child env vars while omitted variables continue to inherit normally. Project
settings override global settings.

The following env vars are **always forced** and cannot be overridden:
- `PI_FORK=1`
- `PI_OFFLINE=1`
- `PI_SUBAGENT_DISABLE_SCHEDULER=1`
- `PI_OBSERVATIONAL_MEMORY_PASSIVE=1`

Invalid entries are ignored: non-string values, empty variable names, names
containing `=`, and keys or values containing null bytes. Empty string values are
allowed.

This does not change the parent agent environment, add per-call env config,
isolate children from inherited env, unset inherited variables, or provide secret
masking/auditing.

### Fork Cost Footer

By default, `pi-fork` adds an extra dimmed footer status line with fork cost:

```text
forks +$0.123
```

The fork cost comes from completed fork tool results, including forks spawned by
forks. Disable the extra footer line with:

```json
{
  "pi-fork": {
    "costFooter": false
  }
}
```

## Concurrency

Only **1 concurrent fork per working directory** is allowed. Attempting a second fork from the same project while one is active returns an error immediately. Forks in different working directories can run at the same time. Stale/orphaned runs (no update for 30+ minutes) are automatically reaped.

## Requirements

- **tmux** must be installed and available. The fork tool returns an error if tmux is unavailable.
- Linux or macOS. Windows is not supported.

## Manual Check

From this directory:

```bash
pi -e .
```

Then ask Pi to use the `fork` tool with a task.

## Related docs

- [Settings reference](../../docs/extensions/fork/settings.md)
- [Usage reference](../../docs/extensions/fork/usage.md)
- [Maintenance reference](../../docs/extensions/fork/maintenance.md)
