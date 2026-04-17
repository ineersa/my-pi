# bg-process usage

This extension overrides `bash` and adds `bg_status`.

- Long-running commands can be moved to background from an interactive prompt.
- Background jobs are tracked by PID and log file.
- Completion sends a follow-up notification.

Tool actions:

- `bg_status({ action: "list" })`
- `bg_status({ action: "log", pid })`
- `bg_status({ action: "stop", pid })`
