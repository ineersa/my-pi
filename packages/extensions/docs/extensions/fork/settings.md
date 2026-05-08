# fork settings

Settings live under `"pi-fork"` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

Supported keys:

- `extensions`: child extension loading policy
  - `null` or omitted: normal child extension loading
  - `[]`: load no child extensions
  - `string[]`: load only the listed extension sources
- `environment`: string-to-string environment overlay for child fork processes
- `costFooter`: boolean toggle for the extra `forks +$...` footer line (default: true)
- `defaultModel`: string, default model/provider for fork children (e.g. `"anthropic/claude-sonnet-4"`)
- `defaultThinking`: string, default thinking level for fork children. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Tool-call parameters (`model`, `thinking`) override their corresponding config defaults per fork invocation.

Notes:

- Project settings override global settings.
- Local extension paths are resolved relative to the settings file directory.
- Environment variables always forced for fork children (cannot be overridden by `pi-fork.environment`):
  - `PI_FORK=1` — triggers auto-exit behaviour and prevents recursive fork tool registration
  - `PI_OFFLINE=1` — avoids startup network/update checks
  - `PI_SUBAGENT_DISABLE_SCHEDULER=1` — prevents scheduler activity inside forks
  - `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` — forces observational memory into passive mode
