# pi-mcp-adapter maintenance

Entry: `extensions/pi-mcp-adapter/pi-mcp-adapter.ts`

Key modules:

- `init.ts` lifecycle/bootstrap
- `proxy-modes.ts` proxy operations
- `direct-tools.ts` direct registration/execution
- `metadata-cache.ts` cache load/flush

On session restart, prior MCP state is shut down before re-init.
