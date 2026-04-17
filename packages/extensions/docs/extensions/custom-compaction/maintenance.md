# custom-compaction maintenance

Entry: `extensions/custom-compaction/custom-compaction.ts`

Subsystems:

- `policy/` parsing, defaults, and patch merge
- `events/` lifecycle + compaction hook handling
- `runtime/` state and effective-policy resolution
- `summary/` template-based summary generation

Keep parser/types/defaults aligned when schema changes.
