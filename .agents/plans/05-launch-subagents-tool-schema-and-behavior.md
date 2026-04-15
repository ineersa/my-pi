# 05 — `launch_subagents` tool: schema + behavior

## Goal
Expose a clean LLM-callable tool that can launch one or many subagents.

---

## Copy from `/home/ineersa/claw/pi-subagents`
- Use `schemas.ts` only as reference for TypeBox style.
- Do **not** port chain/management fields.

---

## New schema (minimal)
Tool name: `launch_subagents`

Fields:
- `agents: string[]` (required; duplicates allowed)
- `task: string` (required)
- `cwd?: string`
- `parallel?: boolean` (default `true`)
- `maxConcurrency?: number` (clamped 1..4)
- `modelOverride?: string` (optional global override)

No DSL fields (`chain`, `tasks`, `action`, etc.).

---

## Steps
1. Define TypeBox params in `subagents-lite/schemas.ts`.
2. Register tool in `subagents-lite/index.ts`.
3. In `execute`:
   - discover agents
   - validate names
   - validate count <= 4
   - dispatch to single or parallel runner
4. Return structured details for UI/history:
   - run id
   - per-agent results
   - aggregate status
5. Add concise `renderCall` and text summary in result.

---

## Prompt guidance (important)
Add explicit tool hints so model naturally calls it when user says:
- “use scout” / “ask researcher”
- “launch scout and researcher”
- “run few scouts” (duplicates in agents array)

Include guidance that max total is 4 and duplicates are valid.

---

## Deliverables
- Stable tool contract usable by base model
- Tool result includes enough metadata for history UI

---

## Acceptance checklist
- [ ] Tool executes single agent request
- [ ] Tool executes multi-agent request
- [ ] Unknown agent names return actionable error with available names
- [ ] `agents.length > 4` rejected before execution
