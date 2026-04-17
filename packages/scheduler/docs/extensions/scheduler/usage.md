# Scheduler extension usage

The extension registers scheduler commands and the `schedule_prompt` tool.

## Commands

- `/loop 5m <prompt>`
- `/loop --workspace 5m <prompt>`
- `/loop cron '<expr>' <prompt>`
- `/remind in 45m <prompt>`
- `/remind --workspace in 45m <prompt>`
- `/schedule` (interactive manager)
- `/schedule list|enable|disable|delete|clear|adopt|release|clear-foreign`
- `/unschedule <id>`

## Scope model

- `instance` (default): owned by one pi instance.
- `workspace`: intended for shared monitors that can be adopted by another instance in the same repo.

## Execution model

- Tasks dispatch only while pi is active and idle.
- Overdue/foreign tasks are restored for review (`resumeRequired`) rather than auto-dispatched on startup.
