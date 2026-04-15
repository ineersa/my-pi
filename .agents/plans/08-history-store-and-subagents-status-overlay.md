# 08 — History store + `/subagents-status` overlay

## Goal
Provide a nice history UI (active + recent runs), inspired by `pi-subagents` but simpler.

---

## Copy from `/home/ineersa/claw/pi-subagents`
- `run-history.ts` (recording pattern)
- `async-status.ts` (list/sort/format run summaries)
- `subagents-status.ts` (overlay component)
- `formatters.ts` (only `formatDuration`, `formatTokens`, `shortenPath`)

---

## Modify for Lite design
1. Storage root:
   - `~/.pi/agent/extensions/subagents-lite/runs/<runId>/status.json`
2. Mode values:
   - `single` or `parallel` (no chain)
3. Status schema simplified:
   - `runId`, `state`, `startedAt`, `lastUpdate`, `endedAt?`, `cwd`, `steps[]`
4. Update status **during foreground runs** too:
   - so overlay can show current activity if opened while running

---

## Steps
1. Create `history/status-store.ts`:
   - `createRun()`, `updateStep()`, `completeRun()`, `failRun()`
2. Integrate store updates into runner/orchestrator lifecycle.
3. Port `listAsyncRunsForOverlay` style helper to read status files.
4. Port/adapt `SubagentsStatusComponent` UI.
5. Register `/subagents-status` command to open overlay.

---

## Optional (nice-to-have)
- Footer widget for active runs (small, max 3 lines), adapted from render widget logic.

---

## Deliverables
- Persistent run history on disk
- Interactive status overlay showing active + recent runs

---

## Acceptance checklist
- [ ] each launch writes a run directory with status file
- [ ] completed/failed runs appear in recent section
- [ ] overlay refreshes periodically without blocking input
- [ ] corrupted status file does not crash overlay
