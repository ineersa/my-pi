# Scheduler extension maintenance

## Operational checks

- Verify scheduler health from UI status and `/schedule list`.
- If ownership looks wrong, use `/schedule adopt <id|all>` or `/schedule release <id|all>`.
- Use `/schedule clear-foreign` to remove tasks owned by other instances.

## Common troubleshooting

- **No tasks firing:** confirm pi is idle/active and task is enabled.
- **Scheduler disabled:** check `PI_SUBAGENT_DISABLE_SCHEDULER` is not `1`.
- **Task not auto-running after restart:** expected for overdue/foreign-owned tasks; review and resume manually.
- **Frequent schedules rejected:** cadence must be at least 1 minute.

## Data hygiene

- Scheduler writes atomically via `*.tmp` rename.
- Empty task sets remove persisted store file.
- Lease heartbeat/staleness logic is used to detect active owner instance.
