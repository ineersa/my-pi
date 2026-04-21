# compact-header maintenance

Entry: `extensions/compact-header.ts`

Dependencies:

- `mcp-shared-state.ts` for MCP status
- `runtime-mode.ts` for safe-mode hiding
- agent name discovery via `lib/agent-discovery.ts`

Subagent header data is cached briefly (`SUBAGENTS_SNAPSHOT_TTL_MS`).
