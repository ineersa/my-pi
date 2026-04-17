# my-pi-theme maintenance

## Source file

- `bin/theme.mjs`

## What to keep stable

- `list` reads `*.json` themes and prints normalized `theme.name` values.
- `set` validates the requested theme before writing settings.
- Scope resolution order should remain:
  1) `--settings`
  2) `--global` / `--project`
  3) project default (`--project`)

## Update checklist

1. If option names change, update help text and docs here.
2. If default theme directory logic changes, update usage examples.
3. Keep write behavior minimal (`settings.theme` assignment only).
