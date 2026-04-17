# subagents-lite maintenance

Entry: `extensions/subagents-lite/subagents-lite.ts`

Important files:

- `commands.ts` command registration (`/run-agent`)
- `runner.ts` runtime launch + tmux pane lifecycle
- `history/status-store.ts` run tracking + persisted reports
- `reporting.ts` custom message payload and summary text
- `tui/subagent-report-message.ts` custom report renderer (Box + Markdown, expandable)
- `lib/intercom-protocol.ts` parent/child signaling

Intercom events are required for parent-child report propagation.

There is no `/subagents-status` overlay in the current implementation; live control is tmux-native.

Keep `compactReport()` trim-only (no hard truncation), otherwise expanded report messages cannot show full child output.
