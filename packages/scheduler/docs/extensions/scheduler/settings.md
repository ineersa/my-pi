# Scheduler extension settings

The scheduler extension does not define a standalone user config object in `settings.json`.
Behavior is controlled by built-in limits/constants and runtime context.

## Runtime toggles

- `PI_SUBAGENT_DISABLE_SCHEDULER=1` disables extension startup (`extensions/scheduler.ts`).
- `oh-pi:safe-mode` event slows scheduler heartbeat and suppresses status churn while safe mode is on.

## Persistence and paths

- Store root: `~/.pi/agent/scheduler/`
- Workspace store: `<root>/<workspace-mirrored-path>/scheduler.json`
- Lease file: alongside store as `scheduler.lease.json`
- Legacy migration source (read once if present): `<cwd>/.pi/scheduler.json`

## Built-in limits

- Max tasks: `50`
- Min recurring cadence: `1m`
- Default recurring interval: `10m`
- Recurring expiry: `3 days`
- Dispatch rate limit: `6` runs/minute
