# jetbrains-index usage

## What it does during a session

When active, the extension adds IDE-first safety rails around agent behavior:

1. **Policy injection**
   - Appends a strict system reminder that maps coding tasks to JetBrains IDE index tools.
   - Adds a one-time session-start nudge to begin with semantic IDE lookups.

2. **Edit/write gate (dumb mode protection)**
   - Before every `edit` or `write`, checks index readiness (`ide_index_status`) with retries.
   - If readiness fails, blocks the current mutation and disables this extension for the rest of the session.

3. **Diagnostics workflow after mutations**
   - Captures baseline diagnostics before mutation for existing files.
   - After successful mutation:
     - syncs changed paths (`ide_sync_files`),
     - waits for index readiness,
     - fetches diagnostics,
     - reports only **newly introduced** issues as a system reminder.

4. **Guardrails and reminders**
   - Read-efficiency reminders for repeated unbounded reads.
   - Hard block for repeated large unbounded reads.
   - Reminder when `mv`/`git mv` appears in bash output (prefer IDE move refactor).
   - Block for sustained non-symbolic exploration streaks (resets after semantic IDE tool usage).

## Typical workflow

- Use IDE index search/definition/reference tools first.
- Use bounded reads (`offset`/`limit`) when reading files.
- Use IDE refactors for symbol rename and file move.
- After edits, address any new diagnostics reminder before finalizing.
