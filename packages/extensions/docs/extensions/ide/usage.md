# IDE Extension — Usage

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

## Status bar

When an IDE is active, the footer shows:
- IDE name and current file path (when no selection)
- IDE name and line count (when text is selected)

## Example workflow

1. Open a file in your JetBrains IDE
2. Select some text
3. In Pi, press `Ctrl+I` to insert the selection
4. Or type `/ide` to get full IDE context
