# IDE Extension — Settings

The IDE extension has no user-configurable settings. It auto-discovers IDE state files from `~/.pi/ide/`.

## Auto-detection

The extension reads all `.json` files in `~/.pi/ide/` and matches them to the current Pi process using:

1. **PID ancestry** — walks parent process tree (Linux only, via `/proc`)
2. **Workspace match** — checks if `process.cwd()` is inside `workspaceFolders`
3. **Most recent** — picks the file with the highest `timestamp`

## Stale file cleanup

Files older than 1 hour are ignored automatically. Use `/ide-clear` to manually remove all state files.
