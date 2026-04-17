# package-list usage

## Where it is used

`INSTALLER_PACKAGES` is imported by `bin/my-pi.mjs` and drives:

- `--help` package listing output
- install loop (`pi install <spec>`)
- remove loop (`pi remove <spec>`)

## Source-specific resolution

- `--source npm`: uses `npm:<npmName>` (plus optional `@version`)
- `--source local`: resolves absolute path from `localPath`

This file is the single package membership source for installer operations.
