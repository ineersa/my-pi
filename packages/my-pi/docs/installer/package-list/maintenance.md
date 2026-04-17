# package-list maintenance

## Editing guidance

When adding/removing package integrations:

1. Update `bin/package-list.mjs` only (single source of truth).
2. Keep `name`, `npmName`, and `localPath` aligned with workspace/package reality.
3. Verify `npx @ineersa/my-pi --help` still prints correct package names.

## Cross-file consistency

After package list changes, update:

- `README.md` installed packages table
- `docs/ai-index.json` (installer package-list entity if structure/path changes)
- this docs folder (settings/usage) if contract changes
