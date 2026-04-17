# skill-palette maintenance

Entry: `extensions/skill-palette/skill-palette.ts`

Notes:

- Read-only filesystem usage for skill/theme discovery.
- Registers a custom renderer for `skill-context` messages.
- Malformed skill files are skipped (best-effort loading).
