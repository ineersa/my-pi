# intercom maintenance

Entry: `extensions/intercom/intercom.ts`

Architecture:

- broker-backed local IPC client (`broker/`)
- custom renderer for incoming messages (`intercom_message`)
- pi-subagents uses intercom for parent/child coordination

When reconnect logic changes, verify deferred/queued message behavior.
