# custom-footer maintenance

Entry: `extensions/custom-footer.ts`

Notes:

- Usage totals are cached and updated incrementally on events.
- PR probing is throttled (`PR_PROBE_COOLDOWN_MS`).
- Footer/overlay hide when runtime safe mode is enabled.
