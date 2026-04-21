# Agent & Chain File Format

## Agent Frontmatter

Agents are `.md` files with YAML frontmatter + markdown system prompt body.

**Locations:**
- User: `~/.agents/{name}.md` or `~/.pi/agent/agents/{name}.md`
- Project: `.pi/agents/{name}.md` or `.agents/{name}.md` (searches up tree)

```yaml
---
name: agent-name
description: What this agent does
tools: read, bash, mcp:server-name          # omit = all builtins; mcp: = MCP tools
extensions:                                  # absent=all, empty=none, csv=allowlist
model: provider/model-name
fallbackModels: model-a, model-b            # ordered retry on provider failure
thinking: high                               # off, minimal, low, medium, high, xhigh
systemPromptMode: replace                    # replace (default) or append
inheritProjectContext: false                 # pass AGENTS.md/CLAUDE.md to child
inheritSkills: false                         # pass skills catalog to child
skill: skill-name-a, skill-name-b            # inject specific skills
output: context.md                           # write results to file
defaultReads: context.md                     # comma-separated files to pre-read
defaultProgress: true                        # maintain progress.md
maxSubagentDepth: 1                          # tighten nesting for children
---

Your system prompt goes here.
```

## Tool Selection Semantics

| `tools` field | Builtin tools | MCP tools |
|---------------|--------------|-----------|
| Omitted | All defaults | None |
| `read, bash` | Only read + bash | None |
| `mcp:server` | All defaults | All from that server |
| `read, mcp:server` | Only read | All from that server |
| `read, mcp:server/tool` | Only read | One specific tool |

`mcp:` entries are additive — they never restrict builtin tools. To restrict builtins, list them explicitly.

## Extension Sandboxing

| `extensions` field | Behavior |
|-------------------|----------|
| Absent | All extensions load |
| Empty (`extensions:`) | `--no-extensions` |
| CSV (`extensions: a,b`) | `--no-extensions --extension a --extension b` |

When `extensions` is present, it takes precedence over paths implied by `tools` entries.

## Chain Files

`.chain.md` files define reusable multi-step pipelines.

**Locations:** Same directories as agents: `~/.agents/{name}.chain.md`, `.pi/agents/{name}.chain.md`

```markdown
---
name: scout-planner
description: Gather context then plan
---

## scout
output: context.md

Analyze the codebase for {task}

## planner
reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create a plan based on {previous}
```

Each `## agent-name` section = one step. Config lines (`output`, `reads`, `model`, `skills`, `progress`) go immediately after the header. Blank line separates config from task text.

Chains support three-state semantics per config key: omitted (inherit from agent default), value (override), `false` (explicitly disable).

## Builtin Overrides

Override builtin agent fields without copying the whole file. In `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "subagents": {
    "disableBuiltins": true,
    "agentOverrides": {
      "scout": { "model": "anthropic/claude-sonnet-4", "inheritProjectContext": true },
      "reviewer": { "disabled": true }
    }
  }
}
```

Overridable fields: `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `disabled`, `skills`, `tools`, `systemPrompt`.

`disableBuiltins: true` bulk-disables all builtins. Individual overrides with `disabled: false` can opt specific ones back in.
