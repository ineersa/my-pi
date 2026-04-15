# 07 — Agents TUI browser + launcher (read-only)

## Goal
Ship a clean TUI for browsing agents and launching one/many quickly.

---

## Copy from `/home/ineersa/claw/pi-subagents`
- `render-helpers.ts` (row/header/footer/fuzzy filter utilities)
- `agent-manager-list.ts` (list navigation patterns)
- optionally tiny pieces from `agent-manager-detail.ts` for details rendering

---

## What to remove from copied code
- create/edit/delete/clone
- chain builder / parallel builder screens
- model/skills editor widgets
- builtin override flows
- text editor subsystem

This is **read-only + launch only**.

---

## New files
- `subagents-lite/tui/render-helpers.ts`
- `subagents-lite/tui/agent-browser.ts`

---

## UX spec (minimal)
- Left list: agents with source badge + model
- Top: search/filter input
- Right/bottom detail block: description, tools, skills, system prompt preview
- Keys:
  - `↑/↓` navigate
  - type to filter
  - `tab` select/unselect for multi-launch (duplicates allowed by repeated tab)
  - `enter` launch selected (or focused)
  - `esc` close

If launching from TUI, prompt for task in simple one-line input overlay or a small input mode.

---

## Steps
1. Build `AgentBrowserComponent` with list + details.
2. Add search/filter scoring.
3. Implement selection model supporting repeated picks (for multiple scouts).
4. On launch, return structured payload to caller command handler.
5. Wire `/agents` command to open this custom overlay.

---

## Deliverables
- Functional `/agents` overlay that can launch subagents without typing full command syntax

---

## Acceptance checklist
- [ ] `/agents` opens overlay and lists discovered agents
- [ ] selecting same agent multiple times is possible
- [ ] launch from overlay triggers same backend as tool/commands
- [ ] overlay closes cleanly on `esc`
