# custom-compaction usage

Commands:

- `/compact-policy` shows the current effective policy
- `/compact-now [focus]` triggers compaction immediately

Runtime behavior:

- checks `agent_end` for proactive compaction trigger
- customizes `session_before_compact` summarization
- updates extension status through session lifecycle events
