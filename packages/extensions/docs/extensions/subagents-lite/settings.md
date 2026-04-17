# subagents-lite settings

No dedicated JSON config file is required.

Behavior is influenced by environment:

- `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` (depth guard)
- child runs set `PI_SUBAGENT_DISABLE_SCHEDULER=1`
- child lifecycle bridge sets per-step metadata:
  - `PI_SUBAGENT_RUN_ID`
  - `PI_SUBAGENT_STEP_INDEX`
  - `PI_SUBAGENT_LABEL`
  - `PI_SUBAGENT_PARENT_INTERCOM_TARGET`

Report/message defaults:

- child final report text is forwarded trimmed (no hard character cap)
- collapsed report message preview shows a short slice; expanded view shows full markdown report text

Agent definitions are discovered from builtin/user/project directories.
