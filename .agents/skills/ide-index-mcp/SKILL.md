---
name: ide-index-mcp
description: >
  Guide for using JetBrains IDE Index MCP tools for code navigation, refactoring, and analysis.
  TRIGGER: When ANY JetBrains index tool is available in-session (prefer current names:
  jetbrains_index__ide_find_references, jetbrains_index__ide_find_definition,
  jetbrains_index__ide_find_class, jetbrains_index__ide_find_file,
  jetbrains_index__ide_search_text, jetbrains_index__ide_diagnostics,
  jetbrains_index__ide_index_status, jetbrains_index__ide_sync_files,
  jetbrains_index__ide_refactor_rename, jetbrains_index__ide_move_file,
  jetbrains_index__ide_type_hierarchy, jetbrains_index__ide_call_hierarchy,
  jetbrains_index__ide_find_implementations, jetbrains_index__ide_find_super_methods).
  Use when performing semantic navigation, diagnostics, refactoring, hierarchy/call-flow,
  or indexed search. Prefer IDE tools over grep/find/sed for semantic code operations.
---

# IDE Index MCP - Agent Guide

## Core Rule

**Prefer JetBrains IDE index tools for semantic operations.**
Use built-in grep/find/bash only when IDE tools do not support the need (mainly regex search).

## Canonical Tool Map (current server)

| Task | Primary tool |
| --- | --- |
| Find usages/references | `jetbrains_index__ide_find_references` |
| Go to definition | `jetbrains_index__ide_find_definition` |
| Find class/interface | `jetbrains_index__ide_find_class` |
| Find file | `jetbrains_index__ide_find_file` |
| Exact indexed word search | `jetbrains_index__ide_search_text` |
| Rename symbol/file safely | `jetbrains_index__ide_refactor_rename` |
| Move file with refs/imports updates | `jetbrains_index__ide_move_file` |
| Diagnostics (file/build/tests) | `jetbrains_index__ide_diagnostics` |
| Type hierarchy | `jetbrains_index__ide_type_hierarchy` |
| Callers/callees tree | `jetbrains_index__ide_call_hierarchy` |
| Interface/abstract implementations | `jetbrains_index__ide_find_implementations` |
| Parent overridden/implemented methods | `jetbrains_index__ide_find_super_methods` |
| IDE readiness | `jetbrains_index__ide_index_status` |
| Sync PSI/VFS after external edits | `jetbrains_index__ide_sync_files` |

## High-Value Updates to Remember

- `jetbrains_index__ide_call_hierarchy` is now practical for day-to-day tracing:
  - use `direction: "callers"` for impact analysis,
  - use `direction: "callees"` for execution flow,
  - tune `depth` and apply any new project-scope/dependency-filter params exposed by `mcp describe`.
- Many search/navigation tools are paginated (`nextCursor`/`cursor`).
  Continue with cursor instead of falling back to broad scans.
- Updated server builds may exclude dependency/vendor sources (e.g., `node_modules`) by default; if not, use available scope/filter params.
- For position-based targets, use `file + line + column`.
  `language + symbol` remains language-handler dependent.

## Pre-Flight

1. If results look wrong or empty, call `jetbrains_index__ide_index_status`.
2. If files changed via `edit`/`write`, call `jetbrains_index__ide_sync_files` for changed paths.
3. Retry semantic query after sync/index readiness.
4. If behavior changed after MCP update, run `mcp describe` for the exact tool before using older examples.

## Parameter Rules

1. Paths are project-relative.
2. `line`/`column` are 1-based.
3. Put `column` on the symbol token, not punctuation/whitespace.
4. Use `project_path` only when required (multi-project).
5. Respect pagination (`nextCursor` -> `cursor`) on large result sets.

## When Built-in Tools Are Acceptable

- Regex-only search patterns (`rg`/`grep`) not supported by `jetbrains_index__ide_search_text`.
- Non-semantic filesystem operations where IDE tools are irrelevant.

## Mistakes to Avoid

1. Grep for usages/definitions instead of semantic IDE tools.
2. Text replace for rename instead of `jetbrains_index__ide_refactor_rename`.
3. `mv/git mv` for source moves instead of `jetbrains_index__ide_move_file`.
4. Forgetting sync after external edits.
5. Ignoring pagination and then assuming “no more results”.

## Quick Workflow Patterns

### Understand how something is used
1. `jetbrains_index__ide_find_references`
2. `jetbrains_index__ide_call_hierarchy` (`direction: "callers"`)

### Understand what something is
1. `jetbrains_index__ide_find_definition`
2. `jetbrains_index__ide_type_hierarchy`
3. `jetbrains_index__ide_find_super_methods`

### Refactor safely
1. `jetbrains_index__ide_refactor_rename`
2. `jetbrains_index__ide_move_file`
3. `jetbrains_index__ide_diagnostics` (validate post-change)
