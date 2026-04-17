# custom-compaction settings

Policy file resolution:

1. `<cwd>/.pi/compaction-policy.json`
2. `~/.pi/agent/compaction-policy.json`
3. built-in defaults

Key policy areas:

- `enabled`
- `trigger`
- `models`
- `summary` and optional `summaryRetention`
- `ui`
- `profiles` (match-based overrides + templates)
