# TUI Reference

## Clarify TUI

Interactive preview/edit screen shown before chain, single (with `clarify: true`), or parallel execution.

**Navigation mode:**

| Key | Action |
|-----|--------|
| `Enter` | Run (foreground) or launch background if `b` toggled |
| `Esc` | Cancel |
| `↑↓` | Navigate steps/tasks |
| `e` | Edit task/template |
| `m` | Select model |
| `t` | Select thinking level |
| `s` | Select skills |
| `b` | Toggle background/async mode (`[b]g:ON` when enabled) |
| `w` | Edit output file (single/chain) |
| `r` | Edit reads list (chain) |
| `p` | Toggle progress tracking (chain) |
| `S` | Save overrides to agent frontmatter file |
| `W` | Save chain to `.chain.md` file (chain only) |

**Model selector:** `↑↓` navigate, `Enter` select, `Esc` cancel, type to fuzzy filter.

**Thinking level selector:** `↑↓` navigate, `Enter` select, `Esc` cancel.

**Skill selector:** `↑↓` navigate, `Space` toggle, `Enter` confirm, `Esc` cancel, type to filter.

**Edit mode (full-screen editor):**

| Key | Action |
|-----|--------|
| `Esc` | Save and exit |
| `Ctrl+C` | Discard and exit |
| `←→` | Move cursor |
| `Alt+←→` | Move by word |
| `↑↓` | Move up/down by display line |
| `PgUp/PgDn` / `Shift+↑↓` | Move by viewport (12 lines) |
| `Home/End` | Start/end of display line |
| `Ctrl+Home/End` | Start/end of text |
| `Alt+Backspace` | Delete word backward |
| Paste | Supported (multi-line) |

## Agents Manager Overlay

Open: `Ctrl+Shift+A` or `/agents`

### Screens

| Screen | Description |
|--------|-------------|
| List | Browse agents/chains, search/filter, scope badges |
| Detail | Resolved prompt, frontmatter fields, recent run history |
| Edit | Pickers and toggles (model, thinking, prompt mode, context, skills, prompt editor) |
| Chain Detail | Flow visualization with dependency map |
| Parallel Builder | Slot management, add same agent multiple times, per-slot task overrides |
| Task Input | Task entry + launch (Tab toggles skip-clarify, defaults to on) |
| New Agent | Templates: Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain |

### List Screen Shortcuts

| Key | Action |
|-----|--------|
| `↑↓` | Navigate |
| `Enter` | View detail |
| Type | Search/filter |
| `Tab` | Toggle selection |
| `Alt+N` | New agent from template |
| `Ctrl+K` | Clone current item |
| `Ctrl+D` / `Del` | Delete |
| `Ctrl+R` | Run (1 agent: launch, 2+: sequential chain) |
| `Ctrl+P` | Parallel builder (from selection or cursor) |
| `Esc` | Clear query → clear selection → close |

### Parallel Builder Shortcuts

| Key | Action |
|-----|--------|
| `↑↓` | Navigate slots |
| `Ctrl+A` | Add agent (search picker) |
| `Del` / `Ctrl+D` | Remove slot |
| `Enter` | Edit per-slot task |
| `Ctrl+R` | Continue to task input (requires 2+ slots) |
| `Esc` | Back to list |

### Builtin Override Edit

| Key | Action |
|-----|--------|
| `Ctrl+S` | Save override |
| `r` | Reset field to builtin value |
| `D` | Remove entire override |
| `Esc` | Back |
