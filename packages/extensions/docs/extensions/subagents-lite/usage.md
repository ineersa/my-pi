# subagents-lite usage

Commands:

- `/run-agent <name> -- <task>`

Tool:

- `launch_subagents` (max 4 agents, duplicates allowed)

Runs execute in tmux panes and report back to the parent session.

Subagent completion messages are expandable custom messages:

- collapsed view shows a short report preview
- expanded view renders the full report in markdown
- live run control (interrupt/kill/attach) is handled directly in tmux panes
