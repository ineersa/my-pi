# intercom usage

Provides local session-to-session messaging.

Command and shortcut:

- `/intercom` opens session list + compose overlay
- `Alt+M` opens intercom overlay

Tool actions:

- `intercom({ action: "list" })`
- `intercom({ action: "send", to, message, ... })`
- `intercom({ action: "ask", to, message, ... })`
- `intercom({ action: "status" })`
