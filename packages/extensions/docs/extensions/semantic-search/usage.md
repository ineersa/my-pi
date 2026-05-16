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

## Indexing

The tool never creates or updates a Vera index automatically. If the target has
no `.vera` directory, it returns an error and tells you to run `vera index .`
manually from that repository first.

The extension also does not start `vera watch .`; run it yourself when you want
live index updates.

## External repositories

Pass `cwd` to search another Vera-indexed repository. Relative paths resolve
against the current workspace. If the target has no `.vera` directory, the tool
returns an error.
