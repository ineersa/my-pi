# verbosity-control settings

Configuration is loaded from a JSON file (first match wins):

1. `<cwd>/.pi/verbosity-control.json`
2. `~/.pi/agent/verbosity-control.json`
3. built-in defaults

## Config keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultVerbosity` | string | `"low"` | Global default verbosity (`"low"`, `"medium"`, or `"high"`) |
| `verbosityByModel` | object | `{}` | Per-model overrides: map of model ID/pattern → verbosity level |

## Built-in defaults

| Model | Verbosity |
| --- | --- |
| `gpt-5.3-codex` | `medium` |
| `gpt-5.4-mini` | `medium` |
| `gpt-5.5` | `low` |
| all others | `low` (or `defaultVerbosity`) |

## Example

```json
{
  "defaultVerbosity": "medium",
  "verbosityByModel": {
    "gpt-5.4-codex": "high",
    "gpt-4*": "medium"
  }
}
```

Wildcard (`*`) and substring matching are supported in per-model keys.
