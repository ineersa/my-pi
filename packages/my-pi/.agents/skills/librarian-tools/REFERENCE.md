# Librarian MCP Tool Reference

This reference describes how to use Librarian tools effectively and efficiently.

## Tool map

1. `librarian_search-libraries`
   - Purpose: discover available indexed libraries and their slugs.
   - Use first unless you already have an exact slug.

2. `librarian_semantic-search`
   - Purpose: intent-based search over source/docs/runtime.
   - Best for “how does X work?” and “where is X implemented?”.

3. `librarian_grep`
   - Purpose: regex/literal pattern matching with context lines.
   - Best for exact verification after semantic search.

4. `librarian_read`
   - Purpose: read exact line windows from repository files.
   - Best for extracting authoritative context around hits.

---

## 1) `librarian_search-libraries`

### Parameters
- `query` (required): natural language discovery query, always include library name in query.
- `limit` (optional, default 10): number of candidate libraries.

### Returns
Ranked libraries with:
- `slug` (required for next tools)
- `description`
- `gitUrl`
- `lastIndexedAt`
- `matchReason`

### Example
- Query: `easyadmin`
- Result slug: `easycorp/easyadminbundle@5.x`

### Tips
- Try vendor + package keywords (`easycorp easyadminbundle`).
- If empty, broaden terms (`admin bundle`, `symfony admin`).

---

## 2) `librarian_semantic-search`

### Parameters
- `library` (required): exact slug from search-libraries.
- `query` (required): search intent.
- `lang` (optional): language filter (`php`, `js`, `md`, `rst`, etc.).
- `path` (optional): glob filter (`src/**`, `doc/**`).
- `type` (optional): symbol type (`class`, `method`, `function`, etc.).
- `scope` (optional): `source`, `docs`, `runtime`, `all`.
- `limit` (optional, 1..100): number of results.

### Returns
Ranked chunks with:
- `file_path`
- `line_start`, `line_end`
- `content`
- optional `symbol_name`, `symbol_type`

### Example patterns
- Docs lookup:
  - `scope="docs"`, query: `login page template`
- Implementation lookup:
  - `scope="source"`, `lang="php"`, query: `configure menu items`
- Narrowed search:
  - `scope="source"`, `path="src/Config/**"`, query: `translation domain`

### Observed behavior
- `lang` is strict. Example: `lang="md"` gave no results for docs stored in `.rst`.
- Switching to `lang="rst"` returned hits immediately.

### Common error
- Invalid slug returns:
  - `Library not found`
  - Hint to run `search-libraries` for valid slugs.

---

## 3) `librarian_grep`

### Parameters
- `library` (required): exact slug.
- `pattern` (required): regex pattern.
- `ignoreCase` (optional, default false).
- `context` (optional, 0..20): surrounding lines.
- `scope` (optional): `source`, `docs`, `runtime`, `all`.
- `limit` (optional, 1..100).

### Returns
Matches with:
- `file_path`
- `line_start`, `line_end`
- `content` (with requested context)

### Example patterns
- Literal-ish (escaped):
  - `@EasyAdmin/page/login\.html\.twig`
- Multi-option:
  - `linktoDashboard|linkToDashboard`
- Key lookup:
  - `translation_domain`

### When to use
- Confirm exact option names, template paths, and identifiers.
- Validate semantic-search findings before final claims.

---

## 4) `librarian_read`

### Parameters
- `library` (required): exact slug.
- `file` (required): relative file path.
- `offset` (optional, default 1): 1-based start line.
- `limit` (optional, default 200): lines to return (max 2000).

### Returns
- `totalLines`
- `lines[]` with `{line, text}`

### Usage pattern
- Read around a semantic/grep hit:
  - Start near `line_start - N`.
  - Pull 20–80 lines for enough context.

### Example
- File: `doc/dashboards.rst`
- Offset: `996`
- Limit: `35`
- Result included the “Login Form Template” section and exact Twig path.

---

## Recommended execution flow

1. Discover slug: `search-libraries`.
2. Locate likely answers: `semantic-search`.
3. Verify exact tokens: `grep`.
4. Capture final context: `read`.
5. Respond with file + line evidence.

---

## Query tuning cheatsheet

- Too broad / noisy:
  - Add `scope`, then `path`, then `lang`, then `type`.
- Too narrow / empty:
  - Remove `lang`/`type` first, then `path`, then widen `scope`.
- Need implementation detail:
  - Prefer `scope="source"`, `lang="php"`, `path="src/**"`.
- Need user-facing guidance:
  - Prefer `scope="docs"`, often `path="doc/**"`.

---

## Output-to-answer checklist

- Include at least one concrete file path.
- Include line ranges for critical claims.
- Distinguish “documented behavior” (docs) vs “actual implementation” (source).
- Mention uncertainty explicitly when search returns no relevant hits.
