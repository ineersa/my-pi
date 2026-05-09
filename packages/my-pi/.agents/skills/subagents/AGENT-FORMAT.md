# Agent File Format

## Agent Frontmatter

Agents are `.md` files with YAML frontmatter + markdown system prompt body.

**Locations:**
- User: `~/.agents/{name}.md` or `~/.pi/agent/agents/{name}.md`
- Project: `.pi/agents/{name}.md` or `.agents/{name}.md` (searches up tree)

```yaml
---
name: agent-name
description: What this agent does
tools: read, bash                          # omit = all builtins; list restricts
model: provider/model-name
fallbackModels: model-a, model-b          # ordered retry on provider failure
thinking: high                             # off, minimal, low, medium, high, xhigh
systemPromptMode: replace                  # replace (default for most) or append
inheritProjectContext: false               # pass AGENTS.md to child
inheritSkills: false                       # pass skills catalog to child
skill: skill-name-a, skill-name-b          # inject specific skills
extensions:                                # absent=all, empty=none, csv=allowlist
output: context.md                         # default output path
defaultReads: context.md                   # comma-separated files to pre-read
defaultProgress: true                      # maintain progress tracking
maxSubagentDepth: 1                        # tighten nesting for children
disabled: true                             # disable this agent
---

Your system prompt goes here.
```

All known frontmatter keys (from `agents.ts`):

| Key | Type | Description |
|-----|------|-------------|
| `name` | string (required) | Agent identifier |
| `description` | string (required) | What the agent does |
| `tools` | comma-list | Builtin tool allowlist + optional MCP entries |
| `model` | string | Default model (`provider/id`) |
| `fallbackModels` | comma-list | Ordered retry candidates |
| `thinking` | string | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `systemPromptMode` | `replace` \| `append` | How to combine with parent prompt |
| `inheritProjectContext` | `true` \| `false` | Pass AGENTS.md to child |
| `inheritSkills` | `true` \| `false` | Pass skills catalog to child |
| `skill` / `skills` | comma-list | Skill names to inject |
| `extensions` | comma-list | Absent = all extensions; empty = none; csv = allowlist |
| `output` | string | Default output filename |
| `defaultReads` | comma-list | Files to pre-read |
| `defaultProgress` | `true` \| `false` | Enable progress tracking |
| `maxSubagentDepth` | number | Per-agent nesting limit (tightens parent) |
| `disabled` | `true` \| `false` | Disable this agent |

Unknown / custom keys are stored in `extraFields` and passed through.

## MCP Tool Semantics

The `tools` field controls both builtin tools and MCP access. MCP entries use the `mcp:` prefix:

| Pattern | Meaning |
|---------|---------|
| No `mcp:` entries | Only listed builtins; no MCP, no ToolSearch |
| `mcp:*` | Listed builtins + ToolSearch + all configured direct MCP tools |
| `mcp:server__tool` | Listed builtins + only that specific MCP tool (double-underscore separator) |

When `mcp:*` or specific MCP entries are present, `pi-mcp-adapter` is auto-loaded in the child process even if `extensions` is empty or restrictive.

Examples:

```yaml
# No MCP — only grep and read builtins
tools: read, grep

# All MCP — all builtins + ToolSearch + all configured direct MCP tools
tools: read, grep, find, ls, bash, write, mcp:*

# Specific MCP — only the listed MCP tools
tools: read, mcp:websearch__search, mcp:websearch__open
```

## Extension Sandboxing

| `extensions` field | Behavior |
|-------------------|----------|
| Absent | All extensions load |
| Empty (`extensions:`) | `--no-extensions` |
| CSV (`extensions: a,b`) | Only listed paths load |

When `extensions` is present, it takes precedence over paths implied by `tools` entries. Note: `pi-mcp-adapter` is auto-injected when MCP is enabled regardless of `extensions`.

## Removed Features

`.chain.md` files are explicitly **ignored** — they are skipped during agent discovery. There is no chain execution, agent manager UI, builtin overrides via `disableBuiltins`/`agentOverrides` settings, or YAML-based agent serialization.
