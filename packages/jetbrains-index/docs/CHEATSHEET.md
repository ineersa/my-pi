# JetBrains Index MCP Cheatsheet

Compiled from the live session on 2026-05-10.

> Notes
> - Prefer these IDE tools over grep/find/sed for semantic code operations.
> - Paths are project-relative.
> - `line` / `column` are 1-based.
> - After external `edit` / `write`, call `jetbrains_index__ide_sync_files` before retrying IDE queries.
> - If results look incomplete, call `jetbrains_index__ide_index_status` first.
> - This sheet includes two tools the fork reported from the MCP server: `jetbrains_index__ide_find_symbol` and `jetbrains_index__ide_file_structure`. Depending on runtime, they may need ToolSearch to load.

## Tool groups

### Search / navigation
- `jetbrains_index__ide_find_class`
- `jetbrains_index__ide_find_file`
- `jetbrains_index__ide_find_symbol`
- `jetbrains_index__ide_search_text`
- `jetbrains_index__ide_find_references`
- `jetbrains_index__ide_find_definition`
- `jetbrains_index__ide_file_structure`

### Diagnostics / indexing
- `jetbrains_index__ide_diagnostics`
- `jetbrains_index__ide_index_status`
- `jetbrains_index__ide_sync_files`

### Refactoring
- `jetbrains_index__ide_refactor_rename`
- `jetbrains_index__ide_move_file`

### Hierarchy / flow
- `jetbrains_index__ide_find_implementations`
- `jetbrains_index__ide_find_super_methods`
- `jetbrains_index__ide_type_hierarchy`
- `jetbrains_index__ide_call_hierarchy`

---

## Search / navigation

### `jetbrains_index__ide_find_class`
**Description:** Search for classes and interfaces by name.

**Use it for:** finding classes/interfaces/enums by name when you do not need general symbol search.

**Key inputs**
- `query`
- optional: `scope`, `language`, `matchMode`, `cursor`, `pageSize`

**Typical response**
```json
{
  "results": [
    { "qualifiedName": "...", "file": "...", "line": 1, "column": 1, "kind": "class" }
  ],
  "nextCursor": "..."
}
```

**Notes**
- Good for camelCase / substring / wildcard matching.
- Use `jetbrains_index__ide_find_symbol` if you need methods, fields, or functions too.

### `jetbrains_index__ide_find_file`
**Description:** Search for files by name using the IDE file index.

**Use it for:** fast file lookup by filename pattern.

**Key inputs**
- `query`
- optional: `scope`, `cursor`, `pageSize`

**Typical response**
```json
{
  "files": [
    { "name": "UserService.java", "path": "src/.../UserService.java", "directory": "src/..." }
  ],
  "nextCursor": "...",
  "hasMore": false
}
```

### `jetbrains_index__ide_find_symbol`
**Description:** Search for symbols by name across the codebase.

**Use it for:** finding classes, methods, fields, and functions when you know a name but not the location.

**Key inputs**
- `query`
- optional: `scope`, `language`, `cursor`, `pageSize`

**Typical response**
```json
{
  "symbols": [
    { "qualifiedName": "...", "file": "...", "line": 1, "column": 1, "kind": "method" }
  ],
  "nextCursor": "..."
}
```

**Notes**
- Follows IntelliJ-style Go to Symbol matching/ranking.

### `jetbrains_index__ide_search_text`
**Description:** Search for text using the IDE word index.

**Use it for:** very fast exact-word search in code, comments, strings, or all contexts.

**Key inputs**
- `query`
- optional: `context`, `caseSensitive`, `cursor`, `pageSize`

**Typical response**
```json
{
  "results": [
    { "file": "...", "line": 1, "column": 1, "contextSnippet": "...", "contextType": "code" }
  ],
  "nextCursor": "..."
}
```

**Notes**
- Exact-word only.
- Not regex.

### `jetbrains_index__ide_find_references`
**Description:** Find all references to a symbol across the project.

**Use it for:** impact analysis before edits, rename, removal, or API changes.

**Targeting modes**
- position-based: `file + line + column`
- Java FQN: `language + symbol`
- pagination: `cursor`

**Typical response**
```json
{
  "references": [
    { "file": "...", "line": 1, "column": 1, "contextSnippet": "...", "referenceType": "method_call" }
  ],
  "nextCursor": "..."
}
```

### `jetbrains_index__ide_find_definition`
**Description:** Go to a symbol definition.

**Use it for:** jumping from usage to declaration.

**Targeting modes**
- position-based: `file + line + column`
- Java FQN: `language + symbol`

**Key inputs**
- optional: `fullElementPreview`, `maxPreviewLines`

**Typical response**
```json
{
  "file": "...",
  "line": 1,
  "column": 1,
  "symbol": "...",
  "preview": "..."
}
```

### `jetbrains_index__ide_file_structure`
**Description:** Get the hierarchical structure of a file, similar to IDE Structure view.

**Use it for:** quick outline of a file without reading the whole thing.

**Key inputs**
- `file`

**Typical response**
```json
{
  "file": "AGENTS.md",
  "language": "Markdown",
  "structure": "heading ...\n  heading ..."
}
```

**Notes**
- Usually returns a formatted tree string, not a nested JSON tree.

---

## Diagnostics / indexing

### `jetbrains_index__ide_diagnostics`
**Description:** Get diagnostics from file analysis, build output, and test results.

**Use it for:** errors, warnings, quick-fix intentions, build failures, and failed tests.

**Key inputs**
- one or more of:
  - `file`
  - `includeBuildErrors: true`
  - `includeTestResults: true`
- optional: `line`, `column`, `startLine`, `endLine`, `severity`, `testResultFilter`, `maxBuildErrors`, `maxTestResults`

**Typical response**
```json
{
  "problems": [ { "file": "...", "line": 1, "column": 1, "severity": "error", "message": "..." } ],
  "intentions": [ { "file": "...", "line": 1, "column": 1, "description": "..." } ],
  "buildErrors": [ { "file": "...", "line": 1, "column": 1, "severity": "error", "message": "..." } ],
  "testResults": [ { "testName": "...", "status": "failed", "errorMessage": "..." } ]
}
```

**Notes**
- Open files usually get richer diagnostics than unopened files.

### `jetbrains_index__ide_index_status`
**Description:** Check whether the IDE is ready for code intelligence.

**Use it for:** pre-flight checks when semantic tools fail or look incomplete.

**Typical response**
```json
{
  "isDumbMode": false,
  "isIndexing": false,
  "indexingProgress": null
}
```

### `jetbrains_index__ide_sync_files`
**Description:** Sync IDE VFS / PSI after external file changes.

**Use it for:** refreshing the IDE after agent edits, file creation, deletion, or moves outside the IDE.

**Key inputs**
- optional: `paths`

**Typical response**
```json
{
  "syncedPaths": ["src/.../File.ts"],
  "success": true,
  "message": "..."
}
```

---

## Refactoring

### `jetbrains_index__ide_refactor_rename`
**Description:** Rename a symbol or file and update all references semantically.

**Use it for:** safe rename instead of text replacement.

**Modes**
- symbol rename: `file + line + column + newName`
- file rename: `file + newName`

**Key inputs**
- optional strategies:
  - `overrideStrategy`
  - `relatedRenamingStrategy`

**Typical response**
```json
{
  "affectedFiles": [ { "file": "...", "changeType": "modified" } ],
  "changeCount": 3,
  "message": "..."
}
```

**Notes**
- Use this instead of `edit`/`write` for renames.

### `jetbrains_index__ide_move_file`
**Description:** Move a file using the IDE refactoring engine.

**Use it for:** moving files while updating imports, references, and package/namespace info where supported.

**Key inputs**
- `file`
- `destination`

**Typical response**
```json
{
  "success": true,
  "affectedFiles": ["src/.../A.ts", "src/.../B.ts"],
  "message": "..."
}
```

**Notes**
- Use this instead of `mv` / `git mv` for code files.

---

## Hierarchy / flow

### `jetbrains_index__ide_find_implementations`
**Description:** Find implementations of an interface, abstract class, or abstract method.

**Use it for:** discovering concrete implementations behind abstractions.

**Targeting modes**
- position-based: `file + line + column`
- Java FQN: `language + symbol`
- pagination: `cursor`

**Typical response**
```json
{
  "implementations": [
    { "file": "...", "line": 1, "column": 1, "kind": "class", "symbol": "..." }
  ],
  "nextCursor": "..."
}
```

### `jetbrains_index__ide_find_super_methods`
**Description:** Find parent methods a method overrides or implements.

**Use it for:** moving upward from an implementation to interface or base declarations.

**Targeting modes**
- position-based: `file + line + column`
- Java FQN: `language + symbol`

**Typical response**
```json
{
  "chain": [
    { "file": "...", "line": 1, "column": 1, "containingClass": "...", "methodSignature": "...", "depth": 1 }
  ],
  "totalLevels": 1
}
```

**Notes**
- Not supported for Rust.

### `jetbrains_index__ide_type_hierarchy`
**Description:** Get the full inheritance hierarchy for a class or interface.

**Use it for:** understanding parent classes/interfaces and subclasses/implementors.

**Targeting modes**
- `className`
- or `file + line + column`

**Typical response**
```json
{
  "target": { "className": "...", "file": "...", "line": 1, "column": 1 },
  "supertypes": [ { "className": "...", "depth": 1, "children": [] } ],
  "subtypes": [ { "className": "...", "depth": 1, "children": [] } ]
}
```

### `jetbrains_index__ide_call_hierarchy`
**Description:** Build a call hierarchy tree for a method or function.

**Use it for:** tracing callers or callees and understanding execution flow.

**Targeting modes**
- position-based: `file + line + column`
- Java FQN: `language + symbol`

**Key inputs**
- required: `direction` = `"callers"` or `"callees"`
- optional: `depth`, `scope`

**Typical response**
```json
{
  "root": { "method": "...", "file": "...", "line": 1, "column": 1 },
  "callers": [
    { "method": "...", "file": "...", "line": 1, "column": 1, "depth": 1, "children": [] }
  ],
  "totalCallers": 1
}
```

**Notes**
- Response may use `callees` / `totalCallees` when `direction` is `"callees"`.
- Rust `callees` can be limited.

---

## Quick selection guide

- **Find a class/interface:** `jetbrains_index__ide_find_class`
- **Find a file:** `jetbrains_index__ide_find_file`
- **Find any symbol:** `jetbrains_index__ide_find_symbol`
- **Find exact text:** `jetbrains_index__ide_search_text`
- **Find usages:** `jetbrains_index__ide_find_references`
- **Go to declaration:** `jetbrains_index__ide_find_definition`
- **See file outline:** `jetbrains_index__ide_file_structure`
- **Check errors/warnings:** `jetbrains_index__ide_diagnostics`
- **Check IDE readiness:** `jetbrains_index__ide_index_status`
- **Refresh IDE caches after edits:** `jetbrains_index__ide_sync_files`
- **Rename safely:** `jetbrains_index__ide_refactor_rename`
- **Move files safely:** `jetbrains_index__ide_move_file`
- **Find implementations:** `jetbrains_index__ide_find_implementations`
- **Find parent overridden methods:** `jetbrains_index__ide_find_super_methods`
- **See inheritance tree:** `jetbrains_index__ide_type_hierarchy`
- **Trace callers/callees:** `jetbrains_index__ide_call_hierarchy`
