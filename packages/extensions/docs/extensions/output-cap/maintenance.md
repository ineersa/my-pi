# output-cap maintenance

Entry: `extensions/output-cap/output-cap.ts`

Notes:

- Hooks `tool_result` and ignores error results.
- Reuses `details.fullOutputPath` when available; otherwise writes a temp file.
- Temp naming includes a session prefix for targeted cleanup.
