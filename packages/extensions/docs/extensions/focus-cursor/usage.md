# focus-cursor usage

`focus-cursor` enables terminal hardware cursor mode for pi's editor and strips the reverse-video software cursor segment from editor rendering.

This helps terminals that differentiate focused vs unfocused windows/panes (for example in split layouts) show a focus-aware cursor while pi is active.

No commands are added; behavior is automatic on `session_start`.
