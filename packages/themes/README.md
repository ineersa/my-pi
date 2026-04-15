# @ineersa/my-pi-themes

Curated color themes for pi.

> These themes are adapted from `oh-pi` and bundled for this `my-pi` workspace.

## Included themes

- catppuccin-mocha
- cyberpunk
- gruvbox-dark
- nord
- oh-p-dark
- tokyo-night

## Install

```bash
pi install npm:@ineersa/my-pi-themes
```

Local development (from this repo):

```bash
pi install ./packages/themes -l
```

## Swap themes

Use either:

1. `/settings` in pi (interactive), or
2. Set `theme` in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "theme": "tokyo-night"
}
```

If you are in this monorepo, you can use the helper command:

```bash
npm run theme:set -- tokyo-night
```
