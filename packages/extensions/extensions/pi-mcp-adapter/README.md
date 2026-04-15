# pi-mcp-adapter (slimmed local fork)

Minimal MCP adapter for Pi focused on core tool access:

- proxy tool (`mcp`) for search/describe/call
- optional direct tool registration (`directTools`)
- lazy server lifecycle + metadata cache
- stdio and HTTP transports (StreamableHTTP with SSE fallback)

This local fork intentionally **does not include**:

- MCP UI integration
- OAuth flows
- interactive `/mcp` panel

If a server requires auth, this build reports `needs-auth` and skips tool calls.

## Install in this repo

This extension is already included via:

- `packages/extensions/extensions/pi-mcp-adapter/index.ts`

Then run:

```bash
npm run install:local
```

## Config

Create `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "disabled-example": {
      "enabled": false,
      "url": "http://127.0.0.1:9001/sse"
    }
  }
}
```

### Server fields

| Field | Description |
|---|---|
| `enabled` | Set `false` to keep server configured but disabled |
| `command` | Executable for stdio transport |
| `args` | Command arguments |
| `env` | Environment variables (`${VAR}` interpolation supported) |
| `cwd` | Working directory |
| `url` | HTTP endpoint |
| `headers` | HTTP headers (`${VAR}` interpolation supported) |
| `auth` | `"bearer"` or `false` |
| `bearerToken` / `bearerTokenEnv` | Bearer token or env var name |
| `lifecycle` | `"lazy"` (default), `"eager"`, `"keep-alive"` |
| `idleTimeout` | Minutes before idle disconnect |
| `exposeResources` | Expose MCP resources as tools (default: `true`) |
| `directTools` | `true`, `string[]`, or `false` |
| `excludeTools` | Tool names to hide (original or prefixed) |
| `debug` | Show server stderr |

### Settings fields

```json
{
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "directTools": false,
    "disableProxyTool": false
  }
}
```

| Setting | Description |
|---|---|
| `toolPrefix` | `"server"` (default), `"short"`, `"none"` |
| `idleTimeout` | Global idle timeout in minutes |
| `directTools` | Global default for direct registration |
| `disableProxyTool` | Hide `mcp` when direct-tools coverage is sufficient |

## Usage

### Proxy tool

- `mcp({})` → status
- `mcp({ server: "name" })` → list server tools
- `mcp({ search: "query" })` → search tools
- `mcp({ describe: "tool_name" })` → show schema/details
- `mcp({ connect: "server-name" })` → connect/reconnect
- `mcp({ tool: "tool_name", args: "{\"k\":\"v\"}" })` → call tool

`args` must be a JSON **string**.

### Commands

- `/mcp` → server status
- `/mcp tools` → list all cached/known tools
- `/mcp reconnect` → reconnect all enabled servers
- `/mcp reconnect <server>` → reconnect one

## Notes

- Metadata cache: `~/.pi/agent/mcp-cache.json`
- Servers are lazy by default
- Disabled servers remain in config and show as `disabled` in status
- Direct tools are registered from cache at startup
- No OAuth/UI support in this fork
