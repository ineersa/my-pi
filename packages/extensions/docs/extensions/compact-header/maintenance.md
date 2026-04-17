# compact-header maintenance

Entry: `extensions/compact-header.ts`

Dependencies:

- `mcp-shared-state.ts` for MCP status
- `runtime-mode.ts` for safe-mode hiding
- `subagents-lite` discovery/history helpers

Subagent header data is cached briefly (`SUBAGENTS_SNAPSHOT_TTL_MS`).
