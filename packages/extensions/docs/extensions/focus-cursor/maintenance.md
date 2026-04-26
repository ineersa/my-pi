# focus-cursor maintenance

Entry: `extensions/focus-cursor.ts`

Behavior:
- On `session_start`, installs a custom editor (`CustomEditor` subclass) and enables hardware cursor mode via `tui.setShowHardwareCursor(true)`.
- Custom editor render removes reverse-video software cursor ANSI spans (`ESC[7m ... ESC[0m`/`ESC[27m`) only when preceded by the hardware cursor marker (`\x1b_pi:c\x07`).
- On `session_shutdown`, restores the previous hardware cursor mode captured at session start.

Notes:
- This extension intentionally affects editor cursor rendering only.
- If terminal cursor behavior appears inconsistent across environments, check terminal-specific cursor/focus settings first.
