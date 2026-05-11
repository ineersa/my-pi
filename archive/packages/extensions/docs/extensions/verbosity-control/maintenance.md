# verbosity-control maintenance

Entry: `extensions/verbosity-control/verbosity-control.ts`

## How it works

Hooks `before_provider_request` and inspects `ctx.model` to determine the
active model and its API type. Only OpenAI Codex (`openai-codex-responses`)
payloads are modified.

The extension resolves verbosity in priority order:

1. User config `verbosityByModel[modelId]`
2. Built-in per-model table
3. User config `defaultVerbosity`
4. Built-in default (`"low"`)

## Commands

| Command | Description |
| --- | --- |
| `/verbosity` | Show current config and active model verbosity |
| `/verbosity <level>` | Set global default verbosity (low/medium/high) |
| `/verbosity <model> <level>` | Set per-model verbosity |
| `/verbosity <model>` | Show verbosity for matching models |

## Config file

Settings are persisted to `~/.pi/agent/verbosity-control.json` when modified
via `/verbosity` commands. The project-level `.pi/verbosity-control.json`
overrides the global file without being written to by commands.

## Notes

- Skips if `payload.text.verbosity` already matches the resolved level to
  avoid needless payload rewrites.
- Wildcard (`*`) and substring matching is supported for per-model keys in
  config files, not for exact model IDs in the built-in table.
- Config is reloaded on every session start; manual file edits take effect
  after `/reload`.
