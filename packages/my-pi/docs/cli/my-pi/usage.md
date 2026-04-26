# my-pi usage

## Purpose

`my-pi` installs or removes the package set defined in `bin/package-list.mjs`.

## Common commands

```bash
npx @ineersa/my-pi
npx @ineersa/my-pi --yes
npx @ineersa/my-pi --local
npx @ineersa/my-pi --remove
npx @ineersa/my-pi --source local
npx @ineersa/my-pi --version 0.1.0
npx @ineersa/my-pi --no-scheduler
```

## Behavior summary

- Default run is **global** and interactive.
- `--yes` skips prompts and accepts defaults.
- `--local` targets project settings (`.pi/settings.json`) and skips global agent/skill flow.
- `--source local` installs from workspace paths (uses `packages/*` local paths).
- `--remove` removes specs instead of installing.
- In interactive installs, scheduler is prompted separately from the rest of the package set (default answer: **No**).
- In non-interactive/default runs (`--yes` or non-TTY), scheduler is kept disabled.
- `--no-scheduler` keeps scheduler disabled and removes an existing scheduler spec in the selected scope/source.

## Install flow (global)

1. Optional restore of bundled `pi-settings` snapshot.
2. Optional package install via `pi install` for each entry in `INSTALLER_PACKAGES`.
3. Set default theme if missing.
4. Ensure safe-guard policy exists.
5. Optional agent/skill install/update into `~/.agents`.
