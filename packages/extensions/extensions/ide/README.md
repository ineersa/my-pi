# IDE Bridge Extension

Reads IDE state from `~/.pi/ide/` JSON files written by the JetBrains Pi IDE Bridge plugin.

## How It Works

1. **Watches** `~/.pi/ide/` directory for JSON files from IDE plugins
2. **Matches** the current Pi process to an IDE using:
   - PID ancestry (walk parent process tree) — most accurate
   - Workspace match (cwd inside workspaceFolders)
   - Most recent timestamp — fallback
3. **Shows** IDE state in footer status bar
4. **Commands** to insert selection or file into conversation

## Commands

| Command | Description |
|---------|-------------|
| `/ide` | Show current IDE state and insert into conversation |
| `/ide-insert` | Insert IDE selection (or current file) into editor |
| `/ide-clear` | Clear all IDE state files |
| `/ide-info` | Show all active IDE state files |
| `/selection` | Insert IDE selection text into conversation |
| `/currentFile` | Insert IDE current file path into conversation |

## Shortcut

| Key | Action |
|-----|--------|
| `Alt+I` | Insert IDE selection (or current file) into editor |
| `Alt+O` | Insert IDE current file path into editor |

## Status Bar

When an IDE is active, the footer shows:
- IDE name and current file path (when no selection)
- IDE name and line count (when text is selected)

## JSON Schema

```json
{
  "pid": 12345,
  "ideName": "intellij",
  "ideVersion": "2024.1",
  "workspaceFolders": ["/home/user/my-project"],
  "currentFile": "/home/user/my-project/src/main.ts",
  "selection": {
    "text": "function hello() { ... }",
    "startLine": 10,
    "endLine": 15
  },
  "timestamp": 1714000000000
}
```
