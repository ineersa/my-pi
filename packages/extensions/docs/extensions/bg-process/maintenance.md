# bg-process maintenance

Entry: `extensions/bg-process.ts`

Implementation details:

- Uses `child_process.spawn()` and in-memory process state.
- Writes logs to temp files (`tmpdir`).
- Terminates unfinished background children on `session_shutdown`.
