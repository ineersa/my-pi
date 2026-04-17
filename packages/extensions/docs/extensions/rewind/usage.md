# rewind usage

Rewind captures exact git-based file snapshots across session boundaries.

Primary user flows:

- `/fork` restore options (conversation-only, restore-all, code-only, undo)
- `/tree` restore options (keep files, restore files, undo)

Snapshot metadata is stored in hidden session entries; snapshot commits are kept alive via `refs/pi-rewind/store`.
