# skill-palette usage

Command:

- `/skill` opens an overlay to select one or more skills for the next prompt.

Flow:

1. Select skills (fuzzy filter + multi-select)
2. Skills are queued and shown in status/widget
3. On `before_agent_start`, queued skill contents are injected as `skill-context`
