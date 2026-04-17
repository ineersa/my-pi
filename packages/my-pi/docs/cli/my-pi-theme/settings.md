# my-pi-theme settings

## Configuration model

`my-pi-theme` is flag-driven and does not keep its own config file.

Key options from `bin/theme.mjs`:

- `--global` / `-g` → write `theme` to `~/.pi/agent/settings.json`
- `--project` / `-p` (default) → write `theme` to `./.pi/settings.json`
- `--settings <path>` → explicit settings file path (overrides scope)
- `--themes-dir <path>` → custom theme directory (default: `packages/themes/themes` relative to repo)

## Settings key written

The command updates one field:

- `settings.theme = <theme-name>`

If the target settings file does not exist, it is created.
