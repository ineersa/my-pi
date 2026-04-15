# 04 — Parallel orchestration with hard cap = 4

## Goal
Allow launching multiple subagents concurrently (including duplicates), capped at 4.

---

## Copy from `/home/ineersa/claw/pi-subagents`
- `parallel-utils.ts`:
  - `mapConcurrent`
  - `aggregateParallelOutputs` (optional, trimmed)
  - `MAX_PARALLEL_CONCURRENCY` pattern

Port into:
- `subagents-lite/lib/parallel.ts`

---

## Modify for this project
- Hard constant: `MAX_SUBAGENTS_PER_RUN = 4`
- Enforce on **expanded list**, not just unique names
  - Example: `['scout','scout','researcher','reviewer','scout']` => reject (5)

---

## Steps
1. Implement launch request normalizer:
   - input can contain duplicate names
   - normalize names and resolve each to concrete agent config
2. Validate max count (<=4), return friendly error otherwise.
3. Implement `runManyAgents(requests, concurrency=4)`:
   - use `mapConcurrent`
   - preserve request order in outputs
4. Add per-instance labels for duplicates:
   - `scout#1`, `scout#2`, etc. in result summary
5. Build merged summary formatter:
   - per agent: status, duration, first output lines
   - overall: success/partial/failure

---

## Error model
- One subagent failure should not cancel others (v1 default).
- Return `partial` outcome when mixed success/failure.

---

## Deliverables
- `runParallelAgents()` utility integrated with runner
- Unit-friendly result shape for UI and history

---

## Acceptance checklist
- [ ] 2–4 agents run concurrently
- [ ] duplicate agents are allowed and clearly labeled
- [ ] >4 launches rejected with clear message
- [ ] partial failure still returns all completed results
