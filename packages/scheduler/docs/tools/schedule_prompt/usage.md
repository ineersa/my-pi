# `schedule_prompt` usage

Use this tool when users ask for reminders, check-backs, or recurring monitoring.

## Examples

- One-time reminder:
  - `{ "action": "add", "kind": "once", "duration": "45m", "prompt": "Check deployment status" }`
- Recurring interval:
  - `{ "action": "add", "kind": "recurring", "duration": "10m", "prompt": "Check CI pipeline" }`
- Recurring cron:
  - `{ "action": "add", "kind": "recurring", "cron": "*/15 * * * *", "prompt": "Review PR queue" }`
- Workspace-scoped monitor:
  - `{ "action": "add", "duration": "30m", "scope": "workspace", "prompt": "Check nightly build" }`
- List/delete/toggle:
  - `{ "action": "list" }`
  - `{ "action": "delete", "id": "<task-id>" }`
  - `{ "action": "disable", "id": "<task-id>" }`

## Notes

- Tasks run only while pi is active and idle.
- The default scope is `instance`; choose `workspace` only when cross-instance adoption is desired.
