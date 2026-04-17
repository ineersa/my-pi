# my-pi

Personal extension bundle + installer for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

One command to install safe-guard, scheduler, themes, and more:

```bash
npx @ineersa/my-pi
```

## What it installs

Running `npx @ineersa/my-pi` registers the following packages globally in `~/.pi/agent/settings.json`:

| Package | What it adds |
|---------|-------------|
| `@ineersa/my-pi-extensions` | safe-guard, bg-process, compact-header, custom-footer, skill-palette, rewind, session-status, usage, pi-mcp-adapter, subagents-lite |
| `@ineersa/my-pi-scheduler` | Recurring checks, one-time reminders, `schedule_prompt` tool |
| `@ineersa/my-pi-jetbrains-index` | Standalone JetBrains index diagnostics gate (IDE-first guardrails + diagnostics sync) |
| `@ineersa/my-pi-themes` | Theme pack: catppuccin-mocha, cyberpunk, gruvbox-dark, nord, oh-p-dark, tokyo-night |

It also:
- Sets `"theme": "cyberpunk"` in global settings (only if no theme is set yet)
- Deploys a default safe-guard policy to `~/.pi/agent/safe-guard.json` (only if absent)

## Global vs Local

### Global (any directory)

```bash
npx @ineersa/my-pi
```

Extensions, theme, and safe-guard policy are available in **every** pi session.

### Local development (this repo)

```bash
npm install
npm run install:local
pi
```

Registers workspace paths in `.pi/settings.json` so you can edit extensions and `/reload` without reinstalling.

### Remove local

```bash
npm run remove:local
```

### Recommended workflow

- **Working in this repo:** `npm run install:local` + `npx @ineersa/my-pi --remove`
- **Working anywhere else:** `npx @ineersa/my-pi` + make sure `.pi/settings.json` doesn't have local paths in projects you open

Never have both global and local registered at the same time — pi loads both and conflicts on tools/flags.

### Remove global

```bash
npx @ineersa/my-pi --remove
```

## Project layout

```text
packages/
  extensions/      # extension bundle (safe-guard, bg-process, rewind, session-status, ...)
  scheduler/       # standalone scheduler extension
  jetbrains-index/ # standalone jetbrains-index extension
  themes/          # curated pi themes
  my-pi/           # installer CLI
```

## Themes

List available themes:

```bash
npm run theme:list
```

Set project-local theme (`.pi/settings.json`):

```bash
npm run theme:set -- tokyo-night
```

Set global theme (`~/.pi/agent/settings.json`):

```bash
npm run theme:set -- nord --global
```

Switch interactively inside pi via `/settings`.

## Safe-guard policy

Safe-guard reads policy from these locations in order:

1. `.pi/safe-guard.json` — project-local (overrides everything)
2. `~/.pi/agent/safe-guard.json` — global fallback
3. Built-in defaults — if neither file exists

This means `npx @ineersa/my-pi` gives you protection everywhere, and individual projects can add per-project rules.

## Global settings snapshot (`pi-settings/`)

You can snapshot your global `~/.pi` into this repo and later restore it on a fresh machine:

```bash
# pull ~/.pi -> ./pi-settings (auth.json excluded)
npm run settings:pull

# push ./pi-settings -> ~/.pi (overwrite matching files, auth.json excluded)
npm run settings:push
```

During global installer runs (`npx @ineersa/my-pi` or `npm run install:global`), you'll now be prompted to apply bundled `pi-settings` as an optional bootstrap step.

## Copy project settings

Copy the current project's `.pi/` directory to another project:

```bash
npm run copy:settings -- /path/to/target-project
```

## MCP servers (optional)

The repo includes example configs for MCP servers, model providers, and settings. To use them:

```bash
# Copy all example configs to global pi config
mkdir -p ~/.pi/agent
cp packages/my-pi/examples/mcp.json ~/.pi/agent/mcp.json
cp packages/my-pi/examples/models.json ~/.pi/agent/models.json
cp packages/my-pi/examples/settings.json ~/.pi/agent/settings.json
```

Or copy individual files:

```bash
# MCP servers (context7, websearch)
cp packages/my-pi/examples/mcp.json ~/.pi/agent/mcp.json

# Model providers (custom providers like llama.cpp)
cp packages/my-pi/examples/models.json ~/.pi/agent/models.json

# Default provider, model, thinking level, enabled models
cp packages/my-pi/examples/settings.json ~/.pi/agent/settings.json
```

> ⚠️ Copying `settings.json` will overwrite your existing preferences (theme, packages, etc.).
> The installer sets theme and packages automatically — only copy this if you want the same provider/model defaults.

Set your Context7 API key (required for context7 MCP):

```bash
export CONTEXT7_API_KEY=your_key_here
```

Edit `~/.pi/agent/models.json` to add your own providers (local LLMs, custom APIs, etc.).
Edit `~/.pi/agent/settings.json` to change default provider/model/thinking level.
Edit `~/.pi/agent/mcp.json` to add/remove MCP servers.

## Publishing

Bump versions and publish all packages:

```bash
npm version patch -w @ineersa/my-pi-extensions -w @ineersa/my-pi-scheduler -w @ineersa/my-pi-jetbrains-index -w @ineersa/my-pi-themes -w @ineersa/my-pi
npm run publish:all
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run typecheck` | Type-check all packages |
| `npm run install:local` | Install from local paths into `.pi/settings.json` |
| `npm run remove:local` | Remove local paths from `.pi/settings.json` |
| `npm run install:global` | Install from local paths into global settings (dev testing) |
| `npm run theme:list` | List available themes |
| `npm run theme:set -- <name>` | Set project theme |
| `npm run theme:set -- <name> --global` | Set global theme |
| `npm run settings:pull` | Snapshot `~/.pi` into `./pi-settings` (excluding auth) |
| `npm run settings:push` | Apply `./pi-settings` to `~/.pi` (excluding auth) |
| `npm run copy:settings -- <dir>` | Copy `.pi/` to another project directory |
| `npm run publish:all` | Publish all packages to npm |

## Packages

| Package | Description |
|---------|-------------|
| `@ineersa/my-pi-extensions` | Extension bundle: safe-guard, bg-process, compact-header, custom-footer, skill-palette, session-status, rewind, usage, pi-mcp-adapter, subagents-lite |
| `@ineersa/my-pi-scheduler` | Standalone scheduler: recurring checks, one-time reminders, `schedule_prompt` tool |
| `@ineersa/my-pi-jetbrains-index` | Standalone JetBrains index diagnostics gate (IDE-first guardrails + diagnostics sync) |
| `@ineersa/my-pi-themes` | Curated theme pack: catppuccin-mocha, cyberpunk, gruvbox-dark, nord, oh-p-dark, tokyo-night |
| `@ineersa/my-pi` | One-command installer for all packages |
