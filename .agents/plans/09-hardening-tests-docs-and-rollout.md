# 09 — Hardening, tests, docs, rollout

## Goal
Finalize extension quality and make it safe to use daily.

---

## Focus areas
1. Validation and safety
2. Lightweight tests
3. Docs and usage examples
4. Final integration checks

---

## Steps
1. **Validation hardening**
   - enforce max agents = 4 everywhere (tool + commands + TUI)
   - sanitize/normalize agent names
   - explicit errors for missing task or unknown agents
2. **Timeout and cancellation**
   - ensure child process termination path is robust
   - return deterministic error payload on timeout
3. **Tests (small, high-value)**
   - frontmatter parse
   - agent merge precedence
   - multi-launch expansion + cap enforcement
   - history listing sort/filter
4. **README updates**
   - `packages/extensions/README.md` add subagents-lite section
   - add `subagents-lite/README.md` with:
     - agent file format
     - commands
     - tool usage examples
     - max-4 rule
5. **Manual QA script**
   - run scout single
   - run scout+researcher parallel
   - run duplicate scouts
   - open `/subagents-status`

---

## Cleanup checklist (ensure removed complexity stays removed)
- [ ] no chain code paths
- [ ] no agent CRUD/editor code
- [ ] no slash bridge/event relay
- [ ] no detached async runner dependency
- [ ] no worktree/intercom integration

---

## Deliverables
- Stable v1 subagents-lite extension ready for daily usage

---

## Final acceptance
- [ ] `npm run typecheck` passes
- [ ] extension loads via `/reload`
- [ ] all core workflows complete without crashes
- [ ] docs reflect actual shipped behavior
