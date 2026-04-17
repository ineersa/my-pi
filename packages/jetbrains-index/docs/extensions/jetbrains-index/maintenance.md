# jetbrains-index maintenance

## Source of truth

Core implementation files:

- `extensions/jetbrains-index/jetbrains-index.ts` — event hooks and guard orchestration
- `extensions/jetbrains-index/problems-tracker.ts` — pre/post mutation diagnostics lifecycle
- `extensions/jetbrains-index/mcp-problems-client.ts` — MCP connectivity, retries, tool discovery
- `extensions/jetbrains-index/prompts.ts` — policy/reminder prompt builders
- `extensions/jetbrains-index/constants.ts` — thresholds, cooldowns, retry timings

## Guardrails to preserve

When updating behavior, keep these invariants intact:

- IDE-first policy reminder remains explicit and task-to-tool mapped.
- `edit`/`write` stay blocked when index readiness fails after retries.
- Post-mutation diagnostics continue to report only **new** issues (baseline diff).
- Sync before diagnostics remains path-scoped (avoid broad/root sync by default).
- Reminder spam controls (cooldowns) remain in place.

## Validation checklist (quick)

1. Start in a workspace **without** `.idea/`:
   - extension should stay dormant.
2. Start in a workspace **with** `.idea/` and valid JetBrains MCP:
   - extension should announce enabled status.
3. Force dumb/indexing mode and attempt `edit`/`write`:
   - mutation should be blocked.
4. Introduce a new code issue via edit:
   - post-edit reminder should include new diagnostics summary.
5. Trigger repeated unbounded reads:
   - reminders should appear; hard block should trigger at threshold.

## Release notes guidance

If you change thresholds/cooldowns/tool mappings, update:

- `docs/extensions/jetbrains-index/settings.md`
- `docs/extensions/jetbrains-index/usage.md`
- `docs/ai-index.json`
