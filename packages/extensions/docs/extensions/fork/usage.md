# fork usage

Entry: `extensions/fork/fork.ts`

Tool:

- `fork({ task: string, model?: string, thinking?: string, background?: boolean })`

Parameters:

- `task` (required): The delegated task. The fork reports back to the parent with dense, concrete output — snippets, signatures, relationships, and anything discovered beyond the task scope.
- `model` (optional): Override the model/provider for this specific fork child (e.g. `"anthropic/claude-sonnet-4"`). Overrides `pi-fork.defaultModel` config.
- `thinking` (optional): Override the thinking level for this fork child. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Overrides `pi-fork.defaultThinking` config.
- `background` (optional): If `true`, launch the fork and return immediately without waiting. A follow-up message is delivered automatically when the fork completes. Useful for long-running tasks that should not block the parent.

Behavior:

- **Wait mode** (default, `background` unset or `false`):
  1. Snapshots the current session branch into a child session file (`session.jsonl`).
  2. Creates a new tmux pane on the right side of the terminal for the fork session.
  3. Launches an interactive child `pi` process in that pane, receiving the snapshot via `--session` and the task as the first message.
  4. The child auto-exits after completing its first full agent response (set to `1` environment triggers hooks that write the result artifact and call `process.exit(0)`).
  5. The parent polls the pane log for an exit marker, then reads the result artifact (`result.json`) to reconstruct the parsed `ForkResult`.
  6. On completion or error, the tmux pane is auto-closed and the result is returned as tool output.
  7. Concurrency is limited to **3 concurrent forks per working directory** (the status-store enforces `MAX_CONCURRENT_FORKS = 3` per `cwd`, with stale-run reaping). Layout is a 2x2 grid: first fork on the right half, second splits the right pane, third splits the left pane — main Pi stays top-left.
- **Background mode** (`background: true`):
  - Same launch flow but returns immediately with a run ID.
  - A follow-up message (`[FORK_DONE]`) is sent automatically when the fork finishes or fails.
- The parent session context window is not polluted by child activity (no streaming events, no intermediate tool calls).
- If tmux is unavailable, the fork tool returns an error immediately.
- Aborting the tool call (Ctrl-C / signal) sends Ctrl-C to the child tmux pane.
- On parent session shutdown, all running forks are cleaned up: tmux panes are killed, PID-based SIGTERM is sent as fallback, and runs are marked as failed.
