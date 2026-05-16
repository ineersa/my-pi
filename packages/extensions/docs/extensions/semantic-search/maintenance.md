# semantic-search maintenance

Entry: `extensions/semantic-search/semantic-search.ts`

## Dependencies

- **Vera binary** must be installed and on `PATH` (the `vera` CLI tool).
- Requires `bash` for the `cd <dir> && vera <...>` execution wrapper.

## Behavior notes

- All vera invocations are wrapped in `bash -c 'cd <target> && vera ...'`
  because vera resolves directory-relative files (`.vera`, `.veraignore`,
  `.gitignore`) from its literal CWD.
- The tool never auto-runs `vera index .` or `vera watch .`; all index creation and updates are manual.
- Searches have a 60-second timeout.
- The tool respects `AbortSignal` for cancellation.
