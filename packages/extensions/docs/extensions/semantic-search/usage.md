# semantic-search usage

Registers the `semantic-search` tool for conceptual/semantic codebase search powered by Vera.

## What it's for

- Finding code by intent/concept when you don't know exact names
- Discovering relevant files, functions, or documentation for a task
- Searching across source code, documentation, or runtime behavior trees

## What it's NOT for

- Exact symbol lookup → use IDE tools (`ide_find_symbol`, `ide_find_references`, etc.)
- File name search → use `ide_find_file` or glob patterns
- Pattern/regex search → use `ide_search_text` or `grep`

## Auto-indexing

When used in the current workspace and no Vera index exists, the tool runs
`vera index .` once, then proceeds with the search. The watcher (`vera watch .`)
also starts automatically to keep the index up to date. If it crashes, it retries
up to 5 times with backoff, then surfaces the error in the TUI.

## External repositories

Pass `cwd` to search another Vera-indexed repository. Relative paths resolve
against the current workspace. If the target has no `.vera` directory, the tool
returns an error — no auto-indexing for external repos.
