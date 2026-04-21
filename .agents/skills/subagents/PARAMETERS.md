# Tool Parameters

## `subagent` Tool

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name (single mode) or management target |
| `task` | string | - | Task string (single mode) |
| `action` | string | - | Management: `list`, `get`, `create`, `update`, `delete` |
| `chainName` | string | - | Chain name for management operations |
| `config` | object | - | Agent/chain config for create/update |
| `output` | string \| false | agent default | Override output file |
| `skill` | string \| string[] \| false | agent default | Override skills |
| `model` | string | agent default | Override model |
| `tasks` | {agent, task, cwd?, count?}[] | - | Parallel tasks |
| `concurrency` | number | 4 | Max concurrent tasks (top-level parallel only) |
| `worktree` | boolean | false | Git worktree isolation for parallel tasks |
| `chain` | ChainItem[] | - | Sequential steps |
| `context` | "fresh" \| "fork" | fresh | Fresh = clean session; fork = branched from parent leaf |
| `chainDir` | string | auto temp | Chain artifacts directory |
| `clarify` | boolean | true (chains) | Show TUI to preview/edit before execution |
| `agentScope` | "user" \| "project" \| "both" | both | Discovery scope |
| `async` | boolean | false | Background execution (chains need clarify: false) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | {bytes?, lines?} | 200KB/5000 lines | Truncation limits |
| `share` | boolean | false | Upload session to GitHub Gist |

## Chain Item Fields

**Sequential step:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | {task} or {previous} | Task template |
| `output` | string \| false | agent default | Output filename |
| `reads` | string[] \| false | agent default | Files to read from chain dir |
| `progress` | boolean | agent default | Progress.md tracking |
| `skill` | string \| string[] \| false | agent default | Skills override |
| `model` | string | agent default | Model override |

**Parallel step:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallel` | ParallelTask[] | required | Tasks to run concurrently |
| `concurrency` | number | 4 | Max concurrent |
| `failFast` | boolean | false | Stop on first failure |
| `worktree` | boolean | false | Git worktree per task |

**ParallelTask:** Same as sequential step, plus `count` (repeat N times).

## Management Actions

```typescript
{ action: "list" }                           // discover agents + chains
{ action: "get", agent: "scout" }            // inspect one
{ action: "create", config: { ... } }        // create agent or chain
{ action: "update", agent: "scout", config: { model: "..." } }
{ action: "delete", agent: "scout" }
```

### Create/Update Config

```typescript
{ action: "create", config: {
  name: "Code Scout",
  description: "...",
  scope: "user" | "project",
  systemPrompt: "...",
  systemPromptMode: "replace" | "append",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "provider/model",
  fallbackModels: ["model-a", "model-b"],
  tools: "read, bash, mcp:server",
  extensions: "",          // empty = no extensions
  skills: "skill-a, skill-b",
  thinking: "high",
  output: "context.md",
  reads: "shared.md",
  progress: true,
  steps: [{ agent: "scout", task: "..." }, ...]  // creates .chain.md
}}
```

Clear optional fields with `false` or `""`: `{ model: false }` or `{ skills: "" }`.

## Status Tool

| Tool | Description |
|------|-------------|
| `subagent_status` | List active async runs or inspect one by id or dir |

```typescript
subagent_status({ action: "list" })       // active async runs
subagent_status({ id: "a53ebe46" })       // inspect one
subagent_status({ dir: "<path>" })        // inspect by dir
```

Async events: `subagent:started`, `subagent:complete`
