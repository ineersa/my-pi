# output-cap usage

Monitors successful tool results.

If text output exceeds cap:

- emits a warning notice
- saves/references full output in `~/.pi/agent/tmp`
- returns a concise message with file path + inspection hints

It also removes stale temp files at startup and session-owned temp files at shutdown.
