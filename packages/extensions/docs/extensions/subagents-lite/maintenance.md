# subagents-lite maintenance

Entry: `extensions/subagents-lite/subagents-lite.ts`

Important files:

- `commands.ts` command registration/overlay
- `runner.ts` runtime launch
- `history/status-store.ts` run tracking
- `lib/intercom-protocol.ts` parent/child signaling

Intercom events are required for parent-child report propagation.
