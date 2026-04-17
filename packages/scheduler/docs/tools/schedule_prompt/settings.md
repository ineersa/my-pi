# `schedule_prompt` settings

`schedule_prompt` is a tool API (no persistent per-tool config file).
Its behavior is defined by the tool parameter schema and scheduler limits.

## Parameter schema summary

- `action` (required):
  - `add`, `list`, `delete`, `clear`, `enable`, `disable`, `adopt`, `release`, `clear_foreign`
- `kind` (optional): `recurring` | `once` (default: `recurring` for `add`)
- `prompt` (optional string, required for `add`)
- `duration` (optional string): duration like `5m`, `2h`, `1 day`
- `cron` (optional string): 5-field or 6-field cron (5-field is normalized with `seconds=0`)
- `scope` (optional): `instance` | `workspace` (default: `instance`)
- `id` (optional string): task id for `delete`/`enable`/`disable`; optional target for `adopt`/`release` (`all` fallback)

## Validation rules

For `action=add`:

- `prompt` is required.
- `kind=once` requires `duration` and rejects `cron`.
- `kind=recurring` accepts either `duration` or `cron` (not both).
- Missing schedule for recurring defaults to `10m` interval.
- Effective cadence must be at least `1m`.
