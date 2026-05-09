# Extension Config & Artifacts

## Extension Config

File: `~/.pi/agent/extensions/subagent/config.json`

```json
{
  "parallel": { "maxTasks": 12, "concurrency": 6 },
  "defaultSessionDir": "~/.pi/agent/sessions/subagent/",
  "maxSubagentDepth": 2
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `parallel.maxTasks` | 8 | Max parallel tasks |
| `parallel.concurrency` | 4 | Default concurrency |
| `defaultSessionDir` | auto | Session log directory fallback |
| `maxSubagentDepth` | 2 | Nesting limit; env `PI_SUBAGENT_MAX_DEPTH` wins; per-agent can tighten but not relax |

## Recursion Guard

Default: 2 levels (`main → subagent → sub-subagent`).

```bash
export PI_SUBAGENT_MAX_DEPTH=3   # allow one more level
export PI_SUBAGENT_MAX_DEPTH=1   # direct subagents only
export PI_SUBAGENT_MAX_DEPTH=0   # disable subagent tool entirely
```

Set `PI_SUBAGENT_MAX_DEPTH` before starting `pi`. Per-agent `maxSubagentDepth` in frontmatter tightens for children. `PI_SUBAGENT_DEPTH` is internal — don't set it.

## Artifacts

Location: `{sessionDir}/subagent-artifacts/`

Per run (sync only — no async jobs):

- `{runId}_{agent}_input.md` — Task prompt
- `{runId}_{agent}_output.md` — Full output (untruncated)
- `{runId}_{agent}_meta.json` — Timing, usage, exit code, model, model fallback attempts

Artifacts are enabled by default (`artifacts: true`) and auto-cleaned after 7 days on extension load.

## Child Result Deterministic Contract

Each spawned child process writes a JSON result artifact before exiting:

```
<tmpdir>/child-result-<runId>-attempt-<N>.json
```

The parent reads this artifact as the **authoritative** result. If the artifact is missing (child never wrote it), the run is classified as failed regardless of process exit code.

This replaces the old heuristic error detection that scanned assistant text for keywords like "error" or "failed".

## Session Logs

Session directory precedence: `sessionDir` param → `config.defaultSessionDir` → temp directory.

With `context: "fork"`, the task is wrapped with a fork-oriented preamble — it does **not** create a branched session file. With `context: "fresh"` (default), the child starts with only its task prompt.

## Removed Features

These config keys and behaviors no longer exist:

- `intercomBridge` — intercom/parent-child coordination removed
- `worktreeSetupHook` / `worktreeSetupHookTimeoutMs` — worktree isolation removed
- Async observability paths (`async-subagent-runs/`) — background execution removed
- Chain directories (`chain-runs/`) — chain execution removed
- `subagent-log-<id>.md` completion files — no async jobs
