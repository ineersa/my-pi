# pi-mcp-adapter usage

Provides:

- **ToolSearch** — keyword-based MCP tool discovery (always active)
- **Direct tools** — selected MCP tools active from turn 1
- **Deferred tools** — all other MCP tools, loaded on demand via ToolSearch
- `/mcp` command — status, tools list, reconnect
- **Status bar** — connected/total server count in Pi footer
- **Call statistics** — optional per-server/per-tool counters

This is a slimmed fork of [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).
See [README](../../README.md) for full features and [examples.md](../../docs/examples.md)
for all configuration patterns.

## How it works

1. **On startup:** Metadata cache loaded. Direct tools registered immediately (from cache).
   Eager/keep-alive servers connected in background.
2. **Per turn:** ToolSearch (always active) lets the LLM discover tools by keyword.
   Discovered tools activate for the *next* turn with full typed schemas.
3. **Tool calls:** Direct and activated deferred tools are first-class Pi tools —
   the LLM calls them normally by name, no JSON-in-JSON wrapper.

## Typical workflow

```
Turn 1: "Find all references to UserService"
        → Agent uses ToolSearch({ query: "find references" })
        → Loads jetbrains_index__ide_find_references

Turn 2: jetbrains_index__ide_find_references({ file: "UserService.java", line: 15, column: 1 })
        → Returns all references with full context
```
