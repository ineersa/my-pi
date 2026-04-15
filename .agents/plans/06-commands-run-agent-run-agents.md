# 06 — Commands layer (`/run-agent`, `/run-agents`, `/agents`, `/subagents-status`)

## Goal
Provide human-friendly command entrypoints on top of `launch_subagents`.

---

## Copy from `/home/ineersa/claw/pi-subagents`
- `slash-commands.ts` references:
  - argument parsing patterns
  - agent name completion patterns
  - command registration style

Port only relevant parts; do not keep slash bridge/chain logic.

---

## Commands to implement
1. `/run-agent <name> -- <task>`
2. `/run-agents <a,b,c> -- <task>`
3. `/agents` (open agent TUI; plan 07)
4. `/subagents-status` (open history/status TUI; plan 08)

---

## Steps
1. Create `subagents-lite/commands.ts`.
2. Implement parser helpers:
   - split by `--`
   - parse comma-separated agent names
   - trim and validate
3. Implement completions:
   - `/run-agent` name completion from registry
4. Route command execution to the same internal function used by tool.
5. On validation errors, use `ctx.ui.notify(..., "error")`.

---

## Remove from source design
- `/chain`, `/parallel`, `/run` DSL variants
- slash request/response event bridge
- cancel-on-ESC streaming bridge complexity

---

## Deliverables
- Commands wired in extension entry
- Commands and tool share one execution backend

---

## Acceptance checklist
- [ ] `/run-agent scout -- map auth flow` works
- [ ] `/run-agents scout,researcher -- investigate X` works
- [ ] bad syntax returns compact usage help
- [ ] tab completion works for `/run-agent`
