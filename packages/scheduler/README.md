# scheduler

Recurring checks, one-time reminders, and the LLM-callable `schedule_prompt` tool for pi.

Tasks run only while pi is active and idle. Scheduler state is persisted in shared pi storage
using a workspace-mirrored path so tasks survive restarts.

## Commands

| Command | Description |
|---------|-------------|
| `/loop 5m <prompt>` | Schedule recurring prompt every 5 minutes |
| `/loop --workspace 5m <prompt>` | Same, but workspace-scoped (survives instance changes) |
| `/loop cron '<expr>' <prompt>` | Schedule recurring prompt via cron expression |
| `/remind in 45m <prompt>` | One-time reminder in 45 minutes |
| `/remind --workspace in 45m <prompt>` | Same, but workspace-scoped |
| `/schedule` | Open interactive TUI task manager |
| `/schedule list` | List all scheduled tasks |
| `/schedule enable <id>` | Enable a task |
| `/schedule disable <id>` | Disable a task |
| `/schedule delete <id>` | Delete a task |
| `/schedule clear` | Clear all tasks |
| `/schedule adopt <id\|all>` | Adopt foreign tasks to this instance |
| `/schedule release <id\|all>` | Release tasks back to unowned |
| `/schedule clear-foreign` | Remove all foreign-owned tasks |
| `/unschedule <id>` | Alias for `/schedule delete` |

## Tool

The `schedule_prompt` tool lets the LLM schedule prompts directly:

- **add** — create recurring or one-shot tasks (supports intervals and cron)
- **list** — list all tasks
- **delete** / **clear** — remove tasks
- **enable** / **disable** — toggle tasks
- **adopt** / **release** / **clear_foreign** — manage multi-instance ownership

## Ownership model

Tasks are **instance-scoped** by default: they belong to one pi instance and other instances
restore them for review instead of auto-running. Use `--workspace` scope for shared CI/build/deploy
monitors that should survive instance changes in the same repository.

When another live instance already owns scheduler activity for the workspace, pi prompts before
taking over. Manage ownership explicitly with:

- `/schedule adopt <id|all>`
- `/schedule release <id|all>`
- `/schedule clear-foreign`

## Limits

| Setting | Value |
|---------|-------|
| Max tasks | 50 |
| Min recurring interval | 1 minute |
| Max dispatches per minute | 6 |
| Recurring task expiry | 3 days |
| Min cron cadence | 1 minute |

## Dependencies

- `croner` — cron expression parsing and next-run calculation

## Related extensions

- **[safe-guard](../extensions/safe-guard/README.md)** — permission gate for dangerous operations
- **[session-status](../extensions/session-status.ts)** — footer status indicator
