# intercom maintenance

Entry: `extensions/intercom/intercom.ts`

Architecture:

- broker-backed local IPC client (`broker/`)
- custom renderer for incoming messages (`intercom_message`)
- event bridge hooks consumed by subagents-lite

When reconnect logic changes, verify deferred/queued message behavior.
