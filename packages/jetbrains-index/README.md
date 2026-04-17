# @ineersa/my-pi-jetbrains-index

Standalone JetBrains index diagnostics gate for pi.

## Install

```bash
pi install npm:@ineersa/my-pi-jetbrains-index
```

Local dev: `pi install ./packages/jetbrains-index -l`

## What it does

- Enforces IDE-first semantic navigation/refactor guidance in sessions.
- Blocks `edit`/`write` while JetBrains index is in dumb mode.
- Syncs changed files via `ide_sync_files` and reports newly introduced diagnostics.
- Adds read-efficiency and non-symbolic exploration guardrails.

For full behavior and activation details, see:

- [`extensions/jetbrains-index/README.md`](extensions/jetbrains-index/README.md)
