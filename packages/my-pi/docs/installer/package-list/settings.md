# package-list settings

## Data contract

`bin/package-list.mjs` exports `INSTALLER_PACKAGES`, an array of objects with:

- `name`: display label used in CLI output
- `npmName`: package spec used for npm source installs/removals
- `localPath`: workspace path used for `--source local`

## Current entries

- `@ineersa/my-pi-extensions` → `packages/extensions`
- `@ineersa/my-pi-scheduler` → `packages/scheduler`
- `@ineersa/my-pi-jetbrains-index` → `packages/jetbrains-index`
- `github:ineersa/pi-observational-memory` → `../pi-observational-memory`
- `@ineersa/my-pi-themes` → `packages/themes`
