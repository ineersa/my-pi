# safe-guard usage

Purpose: permission gate for risky operations.

Behavior:

- Hard-blocks `sudo`
- Prompts for destructive shell commands
- Prompts for `write`/`edit` outside CWD
- Prompts for reads matching protected patterns
- In non-UI contexts, risky operations are blocked

Commands:

- `/safe-guard`
- `/safe-guard-allow-command <pattern>`
- `/safe-guard-allow-path <path>`
- `/safe-guard-protect-read <pattern>`
- `/safe-guard-unprotect-read <pattern>`
