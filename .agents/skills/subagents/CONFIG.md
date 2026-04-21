# Extension Config & Artifacts

## Extension Config

File: `~/.pi/agent/extensions/subagent/config.json`

```json
{
  "parallel": { "maxTasks": 12, "concurrency": 6 },
  "defaultSessionDir": "~/.pi/agent/sessions/subagent/",
  "maxSubagentDepth": 2,
  "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" },
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 30000
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `parallel.maxTasks` | 8 | Max parallel tasks |
| `parallel.concurrency` | 4 | Default concurrency |
| `defaultSessionDir` | auto | Session log directory fallback |
| `maxSubagentDepth` | 2 | Nesting limit. Per-agent can tighten but not relax. Env `PI_SUBAGENT_MAX_DEPTH` wins. |
| `intercomBridge.mode` | "always" | "always" (fresh+fork), "fork" only, or omit to disable |
| `intercomBridge.instructionFile` | default | Custom markdown template, supports `{orchestratorTarget}` placeholder |
| `worktreeSetupHook` | - | Script path (absolute or repo-relative). stdin JSON → stdout JSON |
| `worktreeSetupHookTimeoutMs` | 30000 | Per-worktree hook timeout |

## Recursion Guard

Default: 2 levels (`main → subagent → sub-subagent`).

```bash
export PI_SUBAGENT_MAX_DEPTH=3   # allow one more level
export PI_SUBAGENT_MAX_DEPTH=1   # direct subagents only
export PI_SUBAGENT_MAX_DEPTH=0   # disable subagent tool entirely
```

Set `PI_SUBAGENT_MAX_DEPTH` before starting `pi`. Per-agent `maxSubagentDepth` in frontmatter tightens for children. `PI_SUBAGENT_DEPTH` is internal — don't set it.

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or `<tmpdir>/pi-subagents-<scope>/artifacts/`

Per task:
- `{runId}_{agent}_input.md` — Task prompt
- `{runId}_{agent}_output.md` — Full output (untruncated)
- `{runId}_{agent}.jsonl` — Event stream (sync only)
- `{runId}_{agent}_meta.json` — Timing, usage, exit code, model, fallback attempts

## Chain Directory

`<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/` containing:
- `context.md` — Scout/context-builder output
- `plan.md` — Planner output
- `progress.md` — Worker/reviewer shared progress
- `parallel-{stepIndex}/` — Subdirs for parallel step outputs (`0-{agent}/output.md`)
- Additional files as written by agents

Auto-cleaned after 24 hours on extension startup.

## Async Observability

`<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/`:
- `status.json` — Source of truth for async progress (written atomically)
- `events.jsonl` — Live event stream with subagent metadata
- `output-<n>.log` — Human-readable tail for current step
- `subagent-log-<id>.md` — Written on completion

## Session Logs

JSONL session files per run. Directory precedence: `sessionDir` param → `config.defaultSessionDir` → parent-session-derived path.

With `context: "fork"`, each child starts from `--session <branched-file>` — real session fork, not injected summary.
