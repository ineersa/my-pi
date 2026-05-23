# fork maintenance

Entry: `extensions/fork/fork.ts`

Notes:

- The extension package is named `fork` and registers the `fork` tool.

## File map

| File | Purpose |
|------|---------|
| `fork.ts` | Extension entrypoint: tool registration, child-only auto-exit hooks, session snapshot, background/wait orchestration, parent lifecycle hooks, fork cost status bar, session-shutdown cleanup |
| `runner.ts` | Core runtime: tmux pane creation, launch script generation, log-based exit-polling, result artifact reconstruction |
| `runner-events.js` | Parsing helpers for JSON-mode events (legacy), fork-result summary text (`getResultSummaryText`, `getFinalAssistantText`), activity/tool-execution aggregation |
| `runner-cli.js` | CLI flag inheritance — parses `process.argv` to forward selected parent flags (`--extension`, `--skill`, `--model`, `--thinking`, `--provider`, etc.) to child fork processes |
| `config.ts` | Config loading from `~/.pi/agent/settings.json` and `.pi/settings.json` under key `"pi-fork"`. Fields: `extensions`, `environment`, `costFooter`, `defaultModel`, `defaultThinking` |
| `render.ts` | TUI rendering hooks for fork tool call and result (collapsed/expanded modes, activity lines, usage footer) |
| `cost.ts` | Cost aggregation across session entries and fork result usages. Provides `aggregateInclusiveCost` and `formatForkCostStatus` for the `forks +$...` footer |
| `session-result.ts` | Session file result parser — reads child Pi's `session.jsonl` after exit and extracts final output, usage, model metadata. Older/supplemental to the `result.json` artifact path |
| `types.ts` | Shared type definitions: `ForkResult`, `ForkToolExecution`, `ForkThinkingState`, `ForkActivity`, `ForkRetryState`, `UsageStats`, `ForkDetails`. Also normalization helpers: `normalizeCompletedResult`, `isResultSuccess`, `isResultError` |
| `status-store.ts` | Persistent run status store under `~/.pi/agent/extensions/fork/runs/<runId>/`. Enforces `MAX_CONCURRENT_FORKS = 3` per working directory (`cwd`), stale-run reaping (30-min threshold), `createRun`/`updateRun`/`completeRun`/`failRun`/`countRunningForks`/`listRuns` |
| `env.ts` | `buildChildEnv` — builds child process environment from configured overrides, always forces `PI_OFFLINE=1` and `PI_FORK=1` |
| `tmux.ts` | Tmux pane management: `createForkPane` (2x2 grid, 50/50 split layout), `killPane`, `paneExists`, `sendCtrlCToPane`, `startPaneLogPipe`, `stopPaneLogPipe`, `getPanePid`, `resolveMainPaneId` (TMUX_PANE + /proc ancestry verification), `isAncestorPid`, `getParentPid` |
| `plans/` | Design documents for the tmux-interactive fork rewrite |

## Environment variables forced on fork children

Child processes inherit the parent environment, then apply configured overrides, then force these (in this order, last wins):
- `PI_FORK=1` — triggers auto-exit hooks and prevents recursive fork tool registration in children
- `PI_OFFLINE=1` — avoids startup network/update checks
- `PI_SUBAGENT_DISABLE_SCHEDULER=1` — prevents scheduler activity inside forks
- `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` — forces observational memory into passive mode

These cannot be overridden by `pi-fork.environment`.

## Artifact flow

When `runFork` launches a child:
1. A temp directory is created (`os.tmpdir()/pi-fork-run-*` or `<runId>/runs/<runId>/`).
2. The session snapshot is written to `session.jsonl`.
3. A tmux launch script (`fork.tmux.sh`) is generated with `PI_FORK=1`, `PI_FORK_RESULT_PATH`, `PI_FORK_TASK`, and the `pi --session <sessionPath> <task>` command.
4. The pane log is piped to `pane.log`.
5. The child writes `result.json` on `agent_end` via `writeForkChildResult()`.
6. The parent polls the pane log for a run-specific `__PI_FORK_EXIT_<runId>__:<code>` marker, then reads `result.json` with retries (up to 2s).
7. The pane is auto-closed (wait mode) or left for observation (background mode).
8. If no result artifact is found, a synthetic failure `ForkResult` is constructed.

## Virtual compaction

Before writing the session snapshot, `injectVirtualCompaction` checks whether the
branch would benefit from compaction and observational memory data is available.

Three cases:

1. **Existing compaction with populated OM details** — skip (already good).
2. **Existing compaction with empty OM details** — patch in-place: collect OM data from
   the entire branch and replace the compaction's `summary` and `details` with the
   populated versions. The existing cut point and `firstKeptEntryId` are preserved.
3. **No compaction** — find a cut point via `findCutPoint`, collect OM data from entries
   that will be discarded, build a synthetic `CompactionEntry`, and splice it into the branch.

In all cases the function is purely synchronous with no LLM calls. The fork child sees a
normal compaction entry and `buildSessionContext()` handles it natively. The main session
is never modified.

Requires `pi-observational-memory` to be installed (for the custom entries to exist),
but has no import dependency on it — reads the well-known custom entry types directly.

## Concurrency

- `MAX_CONCURRENT_FORKS = 3` in `status-store.ts`, enforced per working directory (`cwd`). Up to 3 concurrent forks per cwd.
- Stale runs (no update for 30+ minutes) are reaped lazily before `countRunningForks()`.
- Background forks continue running even after the parent tool call completes; they deliver results via `pi.sendUserMessage`.

## Child auto-exit

The child Pi will not exit by itself in normal interactive mode (`while (true)` loop). The extension installs child-side hooks (when `PI_FORK=1`):
- `before_agent_start`: appends `FORK_CHILD_SYSTEM_PROMPT` to the system prompt.
- `agent_end`: writes `result.json` artifact, then calls `process.exit(0)` after a 300ms flush delay.
- `session_shutdown`: calls `process.exit(1)` as a safety net.

## Cost footer

The `forks +$...` footer status line is computed from all `fork` tool results in the session history (including recursive fork results). Updated on `session_start`, `turn_end`, `session_tree`. Disabled when `pi-fork.costFooter` is `false`. The key `fork-cost` is cleared on `session_shutdown`.

## Cleanup on session shutdown

`cleanupRunningForks(cwd, parentSessionFile)` iterates recent runs for the current working directory owned by the shutting-down parent session, kills their tmux panes, sends SIGTERM as fallback, and marks them as failed with `"Parent session shut down. Fork was aborted."`.
