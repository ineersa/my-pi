# jetbrains-index settings

## Activation

This extension is active only when:

- The current working directory contains a `.idea/` directory.
- A `jetbrains-index` MCP server URL is configured (see Configuration below).

If either requirement is missing, the extension stays **dormant** — no prompt injection, no guard behavior, no diagnostics.

## States

| State | Behavior |
|---|---|
| **Dormant** | No `.idea/` or no healthy JetBrains MCP for `ctx.cwd`. Extension does nothing. |
| **Active** | Health check passed at session start. Full-project sync performed. Prompt injection and guard behavior enabled. |
| **Blocked** | IDE/index fails health check mid-session. The current tool call is blocked, user is notified, and the agent run is aborted. User fixes IDE and types `continue` to resume. The extension remains active and recovers on the next turn. |

## Configuration

JetBrains index MCP connection is configured under the `jetbrainsIndex` key in Pi's settings.json.

### Priority

1. **Pi settings.json** — `jetbrainsIndex` key (project `.pi/settings.json` overrides global
   `~/.pi/agent/settings.json`).
2. **Legacy mcp.json** — `mcpServers.jetbrains-index` key (temporary fallback).

### settings.json shape

```json
{
  "jetbrainsIndex": {
    "url": "http://127.0.0.1:3000/mcp",
    "headers": {
      "Authorization": "Bearer ${JETBRAINS_TOKEN}"
    }
  }
}
```

- `url` — the JetBrains index MCP server endpoint (required).
- `headers` — optional HTTP headers. Values can reference environment
  variables with `${VAR_NAME}` syntax — they are expanded at load time.
- Global and project-level `settings.json` are merged, with project values
  overriding global values at the top level of `jetbrainsIndex`.

### mcp.json legacy shape (fallback)

```json
{
  "mcpServers": {
    "jetbrains-index": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${JETBRAINS_TOKEN}"
      }
    }
  }
}
```

### Constants

Behavior is controlled by built-in constants in:

- `extensions/jetbrains-index/constants.ts`

Key built-in limits/intervals:

| Constant | Default | Purpose |
|---|---|---|
| `IDE_INDEX_STATUS_MAX_RETRIES` | 5 | Index readiness retries before failure |
| `IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS` | 2s | Base delay between retries (exponential backoff) |
| `IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS` | 30s | Cap for retry delay |
| `NUDGE_COOLDOWN_MS` | 5m | Cooldown between move refactor nudges |
| `MCP_TOOL_CALL_TIMEOUT_MS` | 30s | Timeout for a single MCP tool call |
| `MCP_CONNECT_TIMEOUT_MS` | 30s | Timeout for initial connection |
| `MCP_MAX_RETRIES` | 3 | Retries for a single tool call |
| `MCP_RECONNECT_DELAY_MS` | 3s | Delay before reconnection attempt |

## Tool expectations

The extension is designed for JetBrains index IDE tools. When active, each registered IDE wrapper tool contributes prompt guidelines to the system prompt Guidelines section, directing the model to prefer IDE tools over bash/find/rg, use specific tools for navigation/refactoring/hierarchy, and respect CWD scope.

## First-class wrapper tools

When active, the extension registers first-class Pi wrapper tools that replace raw JetBrains MCP tool usage. Each wrapper:

- Uses the original MCP tool description and parameter descriptions from the connected IDE server.
- Returns results as TOON text in MCP-native result format.
- Semantic tools share a common targeting contract: prefer `file + line + column` when known, otherwise use `symbol` (with `fileHint` for JS/TS).
- Mutation tools (`ide_rename_symbol`, `ide_rename_file`, `ide_move_file`) are serialized through a shared lock. After a successful IDE mutation, they perform one whole-project sync and wait for index readiness. They do not run diagnostics — a whole-project sync is sufficient after multi-file refactors.

### Public tool surface

| Tool | Backend | Notes |
|---|---|---|
| `ide_find_file` | findFile | Thin passthrough wrapper |
| `ide_search_text` | searchText | Thin passthrough wrapper |
| `ide_find_symbol` | findSymbol / findClass | Merged symbol search with kind filter |
| `ide_find_definition` | findDefinition | Resolver-backed |
| `ide_find_references` | findReferences | Resolver-backed |
| `ide_rename_symbol` | rename | Resolver-backed, mutation-locked; syncs whole project after success, no diagnostics |
| `ide_rename_file` | rename | Not resolver-backed; mutation-locked; syncs whole project after success, no diagnostics |
| `ide_find_implementations` | findImplementations | Resolver-backed |
| `ide_find_super_methods` | findSuperMethods | Resolver-backed |
| `ide_type_hierarchy` | typeHierarchy | Resolver-backed |
| `ide_call_hierarchy` | callHierarchy | Resolver-backed |
| `ide_diagnostics` | diagnostics | Internal: open file + sync + wait + diagnostics |
| `ide_move_file` | moveFile | Mutation-locked; syncs whole project after success, no diagnostics |
| `ide_file_structure` | fileStructure | Thin passthrough wrapper |

## Target resolution

The extension provides a `target-resolver.ts` module for resolving symbol or location
inputs to canonical `{ file, line, column }` targets. It supports:

| Language | Mode | How |
|---|---|---|
| PHP | Strong | findClass + findSymbol, supports `App\\Service\\Foo::bar` |
| Python | Strong | findSymbol with module:Class.method forms |
| TS/JS with fileHint | Strong | findFile → findSymbol scoped to file |
| TS/JS bare | Best-effort | findSymbol → 1=ok, 0=not_found, >1=ambiguous |
| Rust bare | Best-effort | findSymbol → same contract |
| Go bare | Best-effort | findSymbol → same contract |

Resolution always defaults to the current project path. Targets outside CWD are rejected.
