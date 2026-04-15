# 01 — Scaffold extension and wire entry point

## Goal
Create the minimal extension skeleton in `my-pi` and ensure pi can load it.

---

## Copy / modify targets
- **Create new dir:** `packages/extensions/extensions/subagents-lite/`
- **Create:** `index.ts`, `types.ts`, `README.md`
- **Modify:** `packages/extensions/package.json` (`pi.extensions` array)

No ported logic yet, just skeleton + placeholders.

---

## Steps
1. Create folder structure:
   - `subagents-lite/index.ts`
   - `subagents-lite/types.ts`
   - `subagents-lite/README.md`
   - empty subfolders: `lib/`, `history/`, `tui/`, `agents/`
2. In `index.ts`, export default extension function:
   - register temporary command `/agents` that notifies "subagents-lite loaded"
   - register temporary command `/subagents-status` same style
3. Add extension entry to `packages/extensions/package.json`:
   - `"./extensions/subagents-lite"`
4. Add quick README with scope + not-in-scope section.
5. Run `npm run typecheck` and fix any type/import issues.

---

## Guardrails
- Use NodeNext-style relative imports with `.js` extension in TS source.
- Keep placeholders tiny; no copied heavy code in this step.

---

## Deliverables
- New extension directory committed in workspace
- Extension listed in package manifest
- Placeholder commands visible and callable

---

## Acceptance checklist
- [ ] `/reload` succeeds
- [ ] `/agents` command exists
- [ ] `/subagents-status` command exists
- [ ] `npm run typecheck` passes
