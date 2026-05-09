# Tool Parameters

## `subagent` Tool

### Single Mode

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name |
| `task` | string | - | Task string |
| `model` | string | agent default | Override model (e.g. `anthropic/claude-sonnet-4`) |
| `skill` | string \| string[] \| boolean | agent default | Override skills; `false` disables, `true` uses defaults |
| `output` | string \| boolean | agent default | Output file path (relative to cwd) or `false` to disable |
| `context` | `"fresh"` \| `"fork"` | `"fresh"` | Fresh = clean task session; fork = preamble-wrapped task with context tagging |

### Parallel Mode

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `tasks` | TaskItem[] | - | Array of parallel tasks |
| `concurrency` | number | 4 | Max concurrent tasks (capped by config `parallel.concurrency`) |
| `context` | `"fresh"` \| `"fork"` | `"fresh"` | Same as single mode, applied to all tasks |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `"both"` | Agent discovery scope; project wins on name collisions |
| `cwd` | string | - | Working directory for all tasks |
| `artifacts` | boolean | `true` | Write debug artifacts (input/output/metadata) |
| `includeProgress` | boolean | `false` | Include full progress snapshots in result |
| `share` | boolean | `false` | Upload session to GitHub Gist |
| `sessionDir` | string | auto | Directory for session logs |
| `clarify` | boolean | `false` | No-op stub (TUI was removed) |

### Parallel Task Item (`TaskItem`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | required | Task string |
| `cwd` | string | - | Per-task working directory |
| `count` | number | 1 | Repeat this task N times |
| `model` | string | agent default | Per-task model override |
| `skill` | string \| string[] \| boolean | agent default | Per-task skill override |

Only single and parallel foreground execution are supported. The following parameter shapes do **not** exist in the trimmed package:

- No `chain` / `chainName` / `chainDir` params (chain execution removed)
- No `async` param (background execution removed)
- No `worktree` param (worktree isolation removed)
- No `action` / `config` params (agent management CRUD removed)
- No `subagent_status` tool (removed)
