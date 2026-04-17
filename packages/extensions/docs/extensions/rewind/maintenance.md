# rewind maintenance

Entry: `extensions/rewind/rewind.ts`

Operational notes:

- Requires a usable git repository/worktree.
- Uses a temporary git index for snapshot capture.
- Retention rewrites the keepalive ref; treat this path carefully.

Debug custom entries: `rewind-turn`, `rewind-op`, `rewind-fork-pending`.
