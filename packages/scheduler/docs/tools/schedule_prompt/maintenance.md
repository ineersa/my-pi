# `schedule_prompt` maintenance

## Expected responses

- `list` returns a tab-delimited task table in text plus structured `details.tasks`.
- Mutations (`add`, `delete`, `enable`, etc.) return a user-facing message and structured details.

## Common errors

- `missing_prompt` for `add` without `prompt`
- `missing_duration` for one-time reminders without `duration`
- `invalid_duration` for unparseable duration
- `invalid_cron_for_once` when `kind=once` includes `cron`
- `conflicting_schedule_inputs` when recurring `add` provides both `duration` and `cron`
- `invalid_cron` / cadence too frequent (<1m)
- `task_limit` when at max task count

## Operator guidance

- Prefer `scope=instance` unless monitor ownership must move between instances.
- If target task ownership blocks expected behavior, use `adopt`/`release` actions or `/schedule` commands.
