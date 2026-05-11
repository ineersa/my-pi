# jetbrains-index usage

## What it does during a session

When active, the extension provides:

1. **IDE tool prompt guidelines**
   - Each registered IDE wrapper tool contributes prompt guidelines to the system prompt `Guidelines:` block via Pi's `promptGuidelines`.
   - Guidelines direct the model to prefer IDE tools over bash/find/rg, use specific tools for search/analysis/refactoring, and respect CWD scope.

2. **Hard stop on broken IDE/index**
   - Before every tool call, checks IDE/index readiness.
   - If unavailable after retries: blocks the tool, notifies the user, aborts the agent run.
   - User fixes IDE and types `continue` to recover — extension stays active.

3. **Turn-start project sync**
   - On each agent turn start, performs a whole-project sync.

4. **Post-mutation diagnostics**
   - After every successful `edit` or `write`:
     - Opens the file in the IDE.
     - Syncs the changed file path.
     - Waits for index readiness.
     - Runs diagnostics and reports only newly introduced issues.

5. **Move-refactor handling**
   - Detects `mv` / `git mv` targeting files inside CWD.
   - Syncs the whole project after the move so the IDE sees the filesystem change.
   - Nudges toward `ide_move_file` so imports/references are updated automatically.

6. **First-class IDE wrapper tools**
   - Registers first-class Pi tools when IDE is available:

| Tool | Category | Description |
|---|---|---|
| `ide_find_file` | Search | Find files by name using the IDE index |
| `ide_search_text` | Search | Search for exact words using the IDE word index |
| `ide_find_symbol` | Search | Search for symbols (classes, methods, etc.) by name |
| `ide_find_references` | Semantic | Find all references to a symbol |
| `ide_rename_symbol` | Semantic | Rename a symbol with automatic IDE refactoring |
| `ide_rename_file` | Semantic | Rename a file with automatic IDE refactoring |
| `ide_find_implementations` | Semantic | Find implementations of a symbol |
| `ide_find_super_methods` | Semantic | Find parent/overridden methods |
| `ide_type_hierarchy` | Semantic | Show type hierarchy (supertypes/subtypes) |
| `ide_call_hierarchy` | Semantic | Show call hierarchy (callers/callees) |
| `ide_diagnostics` | Diagnostics | Get IDE diagnostics for a project-relative file (optional `level`: `errors`|`warnings`|`all`) |
| `ide_move_file` | Refactor | Move a file and update all references/imports |
| `ide_file_structure` | Navigation | Show file structure overview |

## Mutation behavior for IDE refactor tools

- `ide_rename_symbol`, `ide_rename_file`, and `ide_move_file` perform one whole-project sync
  after a successful IDE mutation, then wait for index readiness.
- These tools do **not** run diagnostics after mutation by design — a
  whole-project sync is sufficient to keep IDE state coherent after a
  multi-file refactor.
- Built-in `edit` and `write` continue to get targeted post-mutation
  diagnostics (open file → sync file → wait for index → diff).

## Targeting guidance

Semantic tools that resolve symbols prefer a location (`file + line + column`) when known.
Otherwise, use `symbol`. For JS/TS, prefer adding `fileHint` when using `symbol` mode.

## Typical workflow

- Use IDE tools for semantic code operations first.
- Prefer `file + line + column` over bare symbol names when known.
- Use `fileHint` for JS/TS symbol lookups.
- After edits, address any new diagnostics before finalizing.
- For file moves: use `ide_move_file` instead of `mv`/`git mv` so references are updated.
- For file renames: use `ide_rename_file` instead of `mv`/`git mv` so imports are updated.
- For symbol renames: use `ide_rename_symbol` instead of raw search/replace edits.
