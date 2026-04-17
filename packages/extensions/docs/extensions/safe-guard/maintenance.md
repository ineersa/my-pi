# safe-guard maintenance

Entry: `extensions/safe-guard/safe-guard.ts`

Key modules:

- `classify.ts` for bash intent classification
- `policy.ts` for policy read/merge/update helpers

Notes:

- Interactive allowlists are persisted immediately.
- Path checks resolve against current CWD before comparison.
