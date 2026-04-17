# my-pi-theme usage

## Purpose

`my-pi-theme` lists available theme names and writes a selected name into pi settings.

## Commands

```bash
# List theme names discovered from *.json files in themes dir
npx --package @ineersa/my-pi my-pi-theme list

# Set project theme (default scope)
npx --package @ineersa/my-pi my-pi-theme set nord

# Set global theme
npx --package @ineersa/my-pi my-pi-theme set cyberpunk --global

# Use custom settings file
npx --package @ineersa/my-pi my-pi-theme set tokyo-night --settings /path/to/settings.json
```

## Validation behavior

- Fails if theme directory does not exist.
- Fails on unknown theme name and prints available names.
- Parses/rewrites JSON settings with pretty formatting.
