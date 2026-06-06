# safe-guard settings

Configuration is loaded from policy files (first match wins):

1. `<cwd>/.pi/safe-guard.json`
2. `~/.pi/agent/safe-guard.json`
3. built-in defaults

Policy keys:

- `enabled` (boolean, default `true`) — set to `false` to start safe-guard disabled; can be toggled per-session with `/safe-guard-toggle`
- `allowCommandPatterns`
- `allowWriteOutsideCwd`
- `allowDestructiveInPaths` (compatibility field)
- `protectedReadPatterns`
- `dangerousCommandPatterns`
