---
name: librarian-tools
description: Uses Librarian MCP to find indexed libraries and retrieve relevant source/docs snippets with semantic search, regex validation, and line-based reading. Use when working with librarian tools, when users ask to use library, asks about docs/documentation, ask "ask librarian", or want answers grounded in indexed repository docs/code.
license: MIT
---

# Librarian MCP Tools

Use this skill to answer questions from indexed repositories using Librarian tools:
`librarian_search-libraries`, `librarian_semantic-search`, `librarian_grep`, and `librarian_read`.

## Quick start

1. Find candidate libraries with `librarian_search-libraries`.
2. Pick one `slug` (example: `easycorp/easyadminbundle@5.x`).
3. Run `librarian_semantic-search` with `scope="docs"` or `scope="source"`.
4. Validate exact claims with `librarian_grep`.
5. Read surrounding lines with `librarian_read`.

## Workflows

### 1) Documentation answer workflow

- [ ] `librarian_search-libraries` with a product/topic, always include library name in query.
- [ ] Choose the best `slug` by description + match reason.
- [ ] `librarian_semantic-search` with `scope="docs"`.
- [ ] If needed, narrow by `lang` (`rst`, `md`) and `path` (`doc/**`).
- [ ] Use `librarian_read` for full local context around best hit.

### 2) Source implementation workflow

- [ ] `librarian_semantic-search` with `scope="source"`.
- [ ] Narrow with `type` (`class`, `method`, etc.) and `path` (`src/**`).
- [ ] Confirm exact symbol/string behavior using `librarian_grep` (regex).
- [ ] Use `librarian_read` at exact lines before summarizing.

### 3) No-results triage

- [ ] If no libraries: broaden search terms (vendor/product/common aliases).
- [ ] If semantic search is empty: remove strict filters (`lang`, `type`, `path`).
- [ ] If still empty: switch `scope` (`docs` ↔ `source` ↔ `all`).
- [ ] If slug is invalid, re-run `librarian_search-libraries` (exact slug required).

## Response quality rules

- Cite file paths and line ranges from Librarian outputs.
- Prefer docs scope for usage guidance; source scope for behavior details.
- Validate important statements with `grep` + `read` before final answer.
- Be explicit when library coverage is missing.

## Advanced usage

See [REFERENCE.md](REFERENCE.md) for complete tool references, parameters, and troubleshooting patterns.
