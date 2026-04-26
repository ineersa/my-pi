# IDE Extension — Maintenance

## Architecture

The IDE extension is a thin watcher over `~/.pi/ide/` JSON files written by IDE plugins (JetBrains, VS Code, Neovim).

### File watching

- Uses `fs.watch()` on the `~/.pi/ide/` directory for instant updates
- Falls back to 500ms polling for reliability (macOS `fs.watch` can be flaky)
- Compares raw concatenated content to detect changes

### Matching priority

1. **PID ancestry** — only works on Linux (reads `/proc/<pid>/status`)
2. **Workspace match** — string prefix check on normalized paths
3. **Most recent** — sort by `timestamp` field

### Graceful failure

- All file I/O errors are silently caught
- Missing directory is created on first check
- Invalid JSON files are skipped
- Stale files (>1h) are ignored

## Adding support for new IDE plugins

To support a new IDE plugin, ensure it writes JSON files to `~/.pi/ide/` with the schema:

```json
{
  "pid": 12345,
  "ideName": "my-ide",
  "ideVersion": "1.0.0",
  "workspaceFolders": ["/path/to/project"],
  "currentFile": "/path/to/file.ts",
  "selection": { "text": "...", "startLine": 10, "endLine": 15 },
  "timestamp": 1714000000000
}
```

The extension auto-discovers files — no config needed.
