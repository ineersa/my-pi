# my-pi settings

## Configuration sources

`my-pi` does not use a package-local config file. Runtime behavior is controlled by CLI flags in `bin/my-pi.mjs`.

Primary flags:

- `--source npm|local` (default: `npm`)
- `--version <ver>` (npm source only)
- `--local` (project scope, `.pi/settings.json`)
- `--remove` (remove installed specs)
- `--yes` (non-interactive defaults)

## Files the installer writes

Depending on flags and prompts, `my-pi` may write:

- `~/.pi/agent/settings.json` (global installs)
- `./.pi/settings.json` (with `--local`)
- `~/.pi/agent/safe-guard.json` (created if missing)
- `~/.agents/*.md` and `~/.agents/skills/*` (global agent/skill install)
- `~/.pi/agent/*` from bundled `pi-settings/agent` snapshot (global mode, when enabled)

## Defaults applied by installer

During global install (`--local` not set), after package install:

- Ensures a default theme in global settings if absent (`cyberpunk`)
- Deploys a default safe-guard policy if `~/.pi/agent/safe-guard.json` does not exist
