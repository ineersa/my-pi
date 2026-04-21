# pi-mcp-adapter maintenance

Entry: `extensions/pi-mcp-adapter/pi-mcp-adapter.ts`

Key modules:

- `init.ts` lifecycle/bootstrap
- `proxy-modes.ts` proxy operations
- `direct-tools.ts` direct registration/execution
- `metadata-cache.ts` cache load/flush
- `toon-encoder.ts` optional TOON encoding of JSON responses (`maybeEncodeToon`)

On session restart, prior MCP state is shut down before re-init.

TOON encoding is applied in both `proxy-modes.ts` (`executeCall`) and `direct-tools.ts` (`createDirectToolExecutor`) after `transformMcpContent`, only for successful non-error results when `settings.toonEncode` covers the server. Dependency: `@toon-format/toon`.
