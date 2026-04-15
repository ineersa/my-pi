# 03 — Single subagent runner core (spawn + stream parse)

## Goal
Run one subagent reliably via child `pi` process and capture output/usage.

---

## Copy from `/home/ineersa/claw/pi-subagents`
1. `pi-spawn.ts` → `subagents-lite/lib/pi-spawn.ts` (mostly as-is)
2. `pi-args.ts` → `subagents-lite/lib/pi-args.ts` (trimmed)
3. Parse logic from:
   - `execution.ts` (`message_end`, `tool_execution_start/end` handling)
   - `subagent-runner.ts` (`runPiStreaming` shape)

---

## Remove while porting
- fallback model retry loop
- intercom detach logic
- artifact/jsonl sidecar writing
- chain placeholders (`{previous}`, `{chain_dir}`)
- worktree/session-share features

---

## New files
- `subagents-lite/runner.ts`
- `subagents-lite/types.ts` additions:
  - `SubagentRunRequest`
  - `SubagentRunResult`
  - `UsageSummary`

---

## Steps
1. Implement `buildPiArgsForAgent(agent, task, overrides)` using trimmed `pi-args`.
2. Implement `runSingleAgent(request)`:
   - spawn child pi in JSON mode
   - parse stdout jsonl events
   - collect assistant text messages
   - collect tool activity + usage counters
   - capture stderr and exit code
3. Build robust final output resolver:
   - prefer last assistant text
   - fallback to accumulated plain lines
4. Normalize result object:
   - `status`: `ok | error`
   - `exitCode`, `durationMs`, `output`, `error?`, `usage?`
5. Add timeout support (default e.g. 10 min) and abort support.

---

## Guardrails
- Do not throw on malformed json lines; skip line.
- Always return structured result even on spawn failure.
- Ensure temp prompt files are cleaned up.

---

## Deliverables
- Reusable `runSingleAgent()` callable from command/tool layers

---

## Acceptance checklist
- [ ] Running one builtin agent returns output text
- [ ] Invalid model/tool error is surfaced in result.error
- [ ] Malformed stdout lines do not crash parser
- [ ] `npm run typecheck` passes
