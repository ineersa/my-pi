# @ineersa/my-pi

Installer CLI for your personal pi package set.

## Usage

```bash
npx @ineersa/my-pi
```

Global install runs are interactive by default and now prompt for:
- extensions/packages install
- scheduler package install (separately, default: No)
- agents/skills install
- optional global settings bootstrap from a bundled `pi-settings` snapshot (if present)

Theme helper (from installed package):

```bash
npx --package @ineersa/my-pi my-pi-theme list
npx --package @ineersa/my-pi my-pi-theme set nord --project
```

## Options

```bash
npx @ineersa/my-pi --local
npx @ineersa/my-pi --remove
npx @ineersa/my-pi --version 0.1.0
npx @ineersa/my-pi --source local
npx @ineersa/my-pi --no-scheduler
```

- `--source npm` (default): install `npm:<package>` specs
- `--source local`: install from local package paths (for development)
- `--yes`: accept all defaults (includes applying bundled `pi-settings` when available)
- `--no-scheduler`: keep scheduler disabled (skip install and remove it if already installed in the same scope/source)

## Installed packages

| Package | Description |
|---------|-------------|
| `@ineersa/my-pi-extensions` | Extension bundle (safe-guard, session-status) |
| `@ineersa/my-pi-scheduler` | Scheduler extension (recurring checks, reminders, `schedule_prompt` tool). Optional: installer prompts separately (default **No**) or can be forced off with `--no-scheduler`. |
| `@ineersa/my-pi-jetbrains-index` | JetBrains index diagnostics gate extension (IDE-first guardrails + diagnostics sync) |
| `@ineersa/my-pi-themes` | Theme pack (catppuccin-mocha, cyberpunk, gruvbox-dark, nord, oh-p-dark, tokyo-night) |
