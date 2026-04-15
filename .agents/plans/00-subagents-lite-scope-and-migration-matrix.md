# 00 — Subagents Lite scope + migration matrix

## Goal
Build a **lean subagents extension** with:
- predefined agents (`scout`, `researcher`, etc.)
- frontmatter-based agent config
- launching one or many subagents in parallel
- **max 4 concurrent subagents**
- nice TUI for agent browsing + launch
- nice history/status UI

No chain DSL, no chain execution, no agent CRUD editor.

---

## Final v1 feature contract
1. LLM-callable tool: `launch_subagents`
2. Commands:
   - `/agents` (TUI browser/launcher)
   - `/run-agent <name> -- <task>`
   - `/run-agents <a,b,c> -- <task>`
   - `/subagents-status` (history + active runs overlay)
3. Agent sources:
   - builtin: extension `agents/*.md`
   - user: `~/.agents/*.md` and `~/.pi/agent/agents/*.md`
   - project: nearest `.pi/agents/*.md` (highest priority)
4. Parallel cap: **4** total requested launches per call.

---

## Copy / trim / drop matrix from `/home/ineersa/claw/pi-subagents`

| Source file | Action | Destination (new) | Notes |
|---|---|---|---|
| `frontmatter.ts` | copy almost as-is | `packages/extensions/extensions/subagents-lite/lib/frontmatter.ts` | keep tiny parser |
| `parallel-utils.ts` | copy + trim | `.../lib/parallel.ts` | keep `mapConcurrent`, set/export hard cap 4 |
| `pi-spawn.ts` | copy mostly as-is | `.../lib/pi-spawn.ts` | keep cross-platform spawn resolution |
| `pi-args.ts` | copy + trim | `.../lib/pi-args.ts` | keep model/tools/skills/systemPrompt arg builder |
| `agents.ts` | selective extraction | `.../agent-registry.ts` | keep only discovery + parse, remove chains/overrides |
| `run-history.ts` | copy + adapt path | `.../history/run-history.ts` | store per-run summaries |
| `async-status.ts` | copy + adapt | `.../history/status-list.ts` | keep list/sort helpers for overlay |
| `subagents-status.ts` | copy + adapt | `.../tui/subagents-status.ts` | keep overlay UX |
| `render-helpers.ts` | copy partial | `.../tui/render-helpers.ts` | keep row/header/footer/filter helpers |
| `execution.ts` + `subagent-runner.ts` | extract minimal runner pieces | `.../runner.ts` | keep streaming parse + final output aggregation |
| `slash-commands.ts` | rewrite minimal | `.../commands.ts` | only 4 commands above |
| `index.ts` | rewrite from scratch | `.../index.ts` | clean extension entry |

### Explicitly drop (do not port)
- `chain-*` files, chain serializers, chain clarify
- agent management CRUD/editor files:
  - `agent-manager*.ts`, `agent-management.ts`, `agent-serializer.ts`, `agent-templates.ts`, `text-editor.ts`
- prompt/slash bridges:
  - `slash-bridge.ts`, `slash-live-state.ts`, `prompt-template-bridge.ts`
- async detached runner stack:
  - `async-execution.ts`, `subagent-runner.ts` detached/JITI mode
- worktree/intercom complexity:
  - `worktree.ts`, `intercom-bridge.ts`
- artifact-heavy pipeline (optional for later):
  - `artifacts.ts`, `single-output.ts`, `file-coalescer.ts`

---

## Implementation order
Follow plans `01` → `09` in sequence. Each file is scoped for one focused context/session.

---

## Exit criteria for the whole epic
- `npm run typecheck` passes.
- Extension loads via `/reload`.
- `/agents` and `/subagents-status` overlays both work.
- Tool can launch:
  - one `scout`
  - `scout + researcher`
  - duplicated agent requests (e.g. 3 scouts)
- Requests with >4 launches fail with clear validation error.
