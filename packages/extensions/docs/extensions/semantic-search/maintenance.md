# semantic-search maintenance

Entry: `extensions/semantic-search/semantic-search.ts`

## Dependencies

- **Vera binary** must be installed and on `PATH` (the `vera` CLI tool).
- Requires `bash` for the `cd <dir> && vera <...>` execution wrapper.

## Behavior notes

- All vera invocations are wrapped in `bash -c 'cd <target> && vera ...'`
  because vera resolves directory-relative files (`.vera`, `.veraignore`,
  `.gitignore`) from its literal CWD.
- The watcher (`vera watch .`) runs only for the current workspace cwd.
- Watcher restart backoff: 2s, 4s, 8s, 16s, 30s (up to 5 retries).
- Searches have a 60-second timeout; index operations have 5 minutes.
- The tool respects `AbortSignal` for cancellation.
