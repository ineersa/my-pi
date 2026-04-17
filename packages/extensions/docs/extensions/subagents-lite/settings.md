# subagents-lite settings

No dedicated JSON config file is required.

Behavior is influenced by environment:

- `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` (depth guard)
- child runs set `PI_SUBAGENT_DISABLE_SCHEDULER=1`

Agent definitions are discovered from builtin/user/project directories.
