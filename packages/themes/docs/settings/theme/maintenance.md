# Theme setting maintenance

Safe update guidelines:
- Keep theme ids in docs synchronized with files in `packages/themes/themes/`.
- If adding/removing/renaming a theme, update:
  - `docs/ai-index.json`
  - `docs/themes/<theme-id>/...`
  - this settings doc list
  - `package.json` publish `files` if needed
- Validate that selected `theme` id exactly matches the theme JSON `name`.
