# @ineersa/my-pi-mcp-adapter

> **MCP (Model Context Protocol) bridge for [Pi coding agent](https://github.com/badlogic/pi-mono).**
> ToolSearch discovery · direct tools · lazy/eager/keep-alive lifecycle · TOON encoding · metadata cache.

[![npm](https://img.shields.io/npm/v/@ineersa/my-pi-mcp-adapter)](https://www.npmjs.com/package/@ineersa/my-pi-mcp-adapter)
[![license](https://img.shields.io/npm/l/@ineersa/my-pi-mcp-adapter)](LICENSE)

---

## ⚠️ Requirement

This extension **requires** pi-mono from the [`refresh-tools-between-turns`](https://github.com/ineersa/pi-mono/tree/refresh-tools-between-turns) branch.

> The `setActiveTools` API is not yet in pi-mono `main`. Without this branch, ToolSearch cannot activate discovered tools, and direct tool registration won't work correctly.

---

## Why this fork?

This is a **slimmed, enhanced fork** of Nico Bailon's excellent [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Here's what's different:

| Feature | Upstream (Nico) | This fork |
|---|---|---|
| **Tool discovery** | Single `mcp` mega-tool with JSON-in-JSON args | **ToolSearch** — search by keyword, load exact tools. Each MCP tool has its own typed schema. |
| **Token efficiency** | ~200 tokens for proxy, but LLM must construct args-as-JSON | **~2000+ tokens saved per turn** by only shipping active tool schemas |
| **Direct tools** | `directTools` in config | Same, plus `MCP_DIRECT_TOOLS` env var for subagents |
| **TOON encoding** | — | **−27% token savings** on JetBrains search results via [TOON](https://github.com/toon-format/toon) compression |
| **`/mcp` panel** | Interactive TUI overlay | Text-based status (`/mcp`, `/mcp tools`, `/mcp reconnect`) |
| **OAuth flows** | Full OAuth with callback server | `needs-auth` detection only — tool calls gracefully skipped |
| **MCP UI** | Browser/Glimpse integration | Not included |
| **Tool activation** | Proxy-based (all tools through one schema) | Individual tool registration — each MCP tool is a first-class Pi tool with its own typed schema |

**The key architectural shift:** Instead of a single `mcp` proxy tool with generic `{tool?, args?, search?, connect?}` schema, every MCP tool is registered individually with its full typed schema. ToolSearch gives the LLM keyword-based discovery, and only the tools it needs are active at any time. This saves thousands of tokens per turn while making tool calls type-safe.

---

## Quick Start

### Install

This package is part of the my-pi monorepo. Install via the one-command installer:

```bash
npx @ineersa/my-pi
```

Or install standalone:

```bash
pi install npm:@ineersa/my-pi-mcp-adapter
```

### Configure a server

Create `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

### Reload & discover

```
/reload
```

Then ask your agent:

> "Search for available MCP tools related to files"

The agent calls `ToolSearch({ query: "files" })`, discovers matching tools, and uses them with full typed schemas on the next turn.

---

## Features at a glance

| Feature | Description | More |
|---|---|---|
| 🔍 **ToolSearch** | Search & load MCP tools by keyword. ~2000+ tokens saved per turn. | [Examples →](docs/examples.md#example-1-toolsearch-discovery) |
| ⚡ **Direct tools** | Frequently-used tools active from turn 1. Config + env var. | [Examples →](docs/examples.md#example-2-direct-tool-registration) |
| 😴 **Lazy startup** | Servers connect on first tool call. No startup delay. | [Examples →](docs/examples.md#example-3-lazy-startup-by-default) |
| 🔄 **Lifecycle modes** | `lazy`, `eager`, `keep-alive` per-server. | [Examples →](docs/examples.md#example-4-three-lifecycle-modes) |
| ⏱️ **Idle timeout** | Auto-disconnect inactive servers. Configurable per-server. | [Examples →](docs/examples.md#example-5-idle-timeout) |
| 📦 **Metadata cache** | Tool schemas cached to disk. Register tools without live connections. 7-day TTL. | [Examples →](docs/examples.md#example-6-metadata-cache) |
| 🚀 **npx binary resolution** | Bypasses ~143MB npm parent process. Direct binary invocation. | [Examples →](docs/examples.md#example-7-npx-binary-resolution) |
| 🗜️ **TOON encoding** | JSON→TOON compression. −27% tokens on JetBrains results. | [Examples →](docs/examples.md#example-8-toon-encoding) |
| 📊 **Call statistics** | Per-server/per-tool counters. Find your most-used tools. | [Examples →](docs/examples.md#example-9-call-statistics) |
| 📥 **Config imports** | Import MCP servers from Cursor, Claude, Codex, Windsurf, VS Code. | [Examples →](docs/examples.md#example-10-config-imports) |
| 📁 **Project-local config** | `.pi/mcp.json` overrides user-global `~/.pi/agent/mcp.json`. | [Examples →](docs/examples.md#example-11-project-local-config) |
| 📖 **Resource tools** | MCP resources exposed as callable Pi tools. | [Examples →](docs/examples.md#example-12-resource-tools) |
| ⏳ **Failure backoff** | 60s cooldown after failed connections. | [Examples →](docs/examples.md#example-13-failure-backoff) |
| 🔐 **Bearer auth** | Env var or static token. OAuth servers gracefully skipped. | [Examples →](docs/examples.md#example-14-bear-your-own-auth) |
| 🛡️ **Collision guard** | Tools shadowing builtins silently skipped. | [Examples →](docs/examples.md#example-15-builtin-collision-guard) |
| 🔀 **Cross-server dedup** | Handles name collisions in `prefix: "none"` / `"short"` modes. | [Examples →](docs/examples.md#example-16-cross-server-deduplication) |
| 📡 **Status bar** | Connected/total server count in Pi footer. | [Examples →](docs/examples.md#example-17-status-bar) |

---

## Configuration Reference

### File locations

| Priority | File | Scope |
|---|---|---|
| 1 (highest) | `.pi/mcp.json` | Project-local overrides |
| 2 | Imported configs | From other tools |
| 3 (base) | `~/.pi/agent/mcp.json` | User global |

### Per-server fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Disable without removing from config |
| `command` | `string` | — | Executable for stdio transport |
| `args` | `string[]` | `[]` | Command arguments |
| `env` | `object` | — | Environment variables (`${VAR}` supported) |
| `cwd` | `string` | — | Working directory |
| `url` | `string` | — | HTTP endpoint (StreamableHTTP/SSE) |
| `headers` | `object` | — | HTTP headers (`${VAR}` supported) |
| `auth` | `"bearer"` or `false` | — | Authentication type |
| `bearerToken` | `string` | — | Static bearer token |
| `bearerTokenEnv` | `string` | — | Env var name for bearer token |
| `lifecycle` | `"lazy"` / `"eager"` / `"keep-alive"` | `"lazy"` | Connection lifecycle mode |
| `idleTimeout` | `number` | global default | Minutes before idle disconnect |
| `startupTimeoutMs` | `number` | `30000` | Connection timeout at startup |
| `exposeResources` | `boolean` | `true` | Expose MCP resources as callable tools |
| `directTools` | `boolean` or `string[]` | `false` | Make specific tools always active |
| `excludeTools` | `string[]` | — | Hide specific tools from LLM |
| `debug` | `boolean` | `false` | Show server stderr |

### Global settings

| Field | Type | Default | Description |
|---|---|---|---|
| `toolPrefix` | `"server"` / `"short"` / `"none"` | `"server"` | Tool name prefix style |
| `idleTimeout` | `number` | `10` | Global idle timeout in minutes |
| `toonEncode` | `boolean` or `string[]` | — | Enable TOON encoding (`true` = all, array = specific servers) |
| `captureStats` | `boolean` or `object` | — | Enable call statistics |

### Commands

| Command | Description |
|---|---|
| `/mcp` or `/mcp status` | Show server connection status |
| `/mcp tools` | List all available tool names |
| `/mcp reconnect` | Reconnect all enabled servers |
| `/mcp reconnect <server>` | Reconnect a specific server |

### Environment variables

| Variable | Description |
|---|---|
| `MCP_DIRECT_TOOLS` | Comma-separated server/tool specifiers. `*` = all servers, `server_name` = all tools from that server, `server/tool` = specific tool, `__none__` = no direct tools |
| `MCP_UI_DEBUG=1` | Enable debug logging |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Pi Agent                              │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Builtins │  │  ToolSearch  │  │  Direct MCP       │   │
│  │ (active) │  │  (active)    │  │  Tools (active)   │   │
│  └──────────┘  └──────┬───────┘  └──────────────────┘   │
│                       │                                  │
│                       │ discover ▼                       │
│               ┌───────▼────────┐                         │
│               │ Deferred MCP   │  Inactive until         │
│               │ Tools          │  discovered via         │
│               │                │  ToolSearch             │
│               └────────────────┘                         │
└──────────────────────┬──────────────────────────────────┘
                       │
          pi-mcp-adapter layer
                       │
   ┌───────────────────┼───────────────────┐
   │ lifecycle manager │ metadata cache    │
   │ health checks     │ ~/.pi/agent/      │
   │ idle timeout      │ mcp-cache.json    │
   └───────────────────┼───────────────────┘
                       │
             ┌─────────┼──────────┐
             │ stdio   │ HTTP      │ SSE
             ▼         ▼           ▼
          MCP Svr   MCP Svr     MCP Svr
```

---

## Documentation

| Document | Content |
|---|---|
| [examples.md](docs/examples.md) | All 17 examples with JSON configs and usage patterns |
| [architecture.md](docs/architecture.md) | Full technical architecture — module map, lifecycle, data flow, transport layer |
| [settings.md](docs/extensions/pi-mcp-adapter/settings.md) | Detailed settings reference |
| [usage.md](docs/extensions/pi-mcp-adapter/usage.md) | Usage overview |
| [maintenance.md](docs/extensions/pi-mcp-adapter/maintenance.md) | Module map, key events, tool registration flow |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## License

MIT © 2026 Nico Bailon (original) · Ineersa (fork additions: ToolSearch, TOON encoding, direct tool activation)

This project is a fork of [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) by Nico Bailon, modified and maintained as part of the [my-pi](https://github.com/ineersa/my-pi) monorepo. All original copyright and permission notices are preserved. See [LICENSE](LICENSE) for the full text.

The following components are new in this fork:
- **ToolSearch** — keyword-based tool discovery replacing the `mcp` proxy mega-tool
- **TOON encoding** — JSON→TOON compression for token-efficient MCP responses
- Tool activation via `pi.setActiveTools()` (requires pi-mono `refresh-tools-between-turns`)
- Slimmed scope: no OAuth flows, no MCP UI panel, text-based `/mcp` commands only
