# safe-guard settings

Configuration is loaded from policy files (first match wins):

1. `<cwd>/.pi/safe-guard.json`
2. `~/.pi/agent/safe-guard.json`
3. built-in defaults

Policy keys:

- `allowCommandPatterns`
- `allowWriteOutsideCwd`
- `allowDestructiveInPaths` (compatibility field)
- `protectedReadPatterns`
- `dangerousCommandPatterns`
