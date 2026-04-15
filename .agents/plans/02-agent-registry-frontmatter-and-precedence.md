# 02 — Agent registry: frontmatter parsing + source precedence

## Goal
Implement agent discovery/loading with simple frontmatter and precedence rules.

---

## Copy from `/home/ineersa/claw/pi-subagents`
1. `frontmatter.ts` → copy almost verbatim into:
   - `packages/extensions/extensions/subagents-lite/lib/frontmatter.ts`
2. `agents.ts` + `agent-selection.ts` → **extract only**:
   - `loadAgentsFromDir` core parsing logic
   - nearest-project lookup logic
   - merge precedence logic (project > user > builtin)

---

## What to remove while porting
- chain support (`*.chain.md`, `parseChain`, chain types)
- builtin override settings logic (`subagents.agentOverrides`)
- management helpers (`saveBuiltinAgentOverride`, `removeBuiltinAgentOverride`)
- extra fields not needed for v1

---

## New files
- `subagents-lite/agent-registry.ts`
- `subagents-lite/types.ts` (agent config interfaces)
- builtin files under `subagents-lite/agents/`:
  - `scout.md`
  - `researcher.md`
  - `delegate.md` (light default)
  - optional: `reviewer.md`, `worker.md`

---

## Required frontmatter v1
- `name` (required)
- `description` (required)
- `model` (optional)
- `tools` (optional comma list)
- `skills` or `skill` (optional comma list)

Body markdown = `systemPrompt`.

---

## Steps
1. Port frontmatter parser utility.
2. Implement `discoverAgents(cwd)` that returns resolved list with source metadata.
3. Support directories:
   - builtin: extension `agents/`
   - user: `~/.agents`, `~/.pi/agent/agents`
   - project: nearest `.pi/agents`
4. Merge with last-write-wins precedence:
   - builtin -> user -> project.
5. Add helper `getAgentByName(name, cwd)`.
6. Add temporary debug command output in `/agents --text` (optional) to validate loads.

---

## Deliverables
- Working registry module returning merged agents
- Builtin agent markdowns present in extension

---

## Acceptance checklist
- [ ] If same name exists in builtin + project, project wins
- [ ] Missing/invalid frontmatter file is skipped safely
- [ ] `discoverAgents` returns stable sorted list (name asc)
- [ ] `npm run typecheck` passes
