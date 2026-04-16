# Plan: Automatic JetBrains Problem Checking

Reimplement Claude Code's `DiagnosticTrackingService` pattern using the JetBrains
MCP `get_file_problems` tool instead of a custom IDE plugin RPC. Hold a background
MCP SSE connection from the extension to call `get_file_problems` before and after
edits, diff the results, and inject new problems as `<new-diagnostics>` system
reminders — exactly like Claude Code does.

---

## 1. How Claude Code Does It (Reference Implementation)

### Source files
- `src/services/diagnosticTracking.ts` — `DiagnosticTrackingService`
- `src/utils/attachments.ts` — `getDiagnosticAttachments()`
- `src/utils/messages.ts` — renders diagnostics attachment into conversation
- `src/tools/FileEditTool/FileEditTool.ts:425` — calls `diagnosticTracker.beforeFileEdited()`
- `src/tools/FileWriteTool/FileWriteTool.ts:247` — calls `diagnosticTracker.beforeFileEdited()`
- `src/screens/REPL.tsx:2667` — calls `diagnosticTracker.handleQueryStart()`

### Data types (exact)

```typescript
// src/services/diagnosticTracking.ts
interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}
```

### Flow

```
1. handleQueryStart() — find connected IDE MCP client, init service
2. beforeFileEdited(filePath) — call getDiagnostics({uri: "file://<path>"}) → store baseline
3. File edit happens (edit/write tool executes)
4. getNewDiagnostics() — call getDiagnostics({}) for ALL files → diff against baseline
5. Format diff as summary string
6. Inject as attachment → rendered as <new-diagnostics> in <system-reminder>
```

### Exact injection format

The diagnostics are wrapped in `wrapMessagesInSystemReminder()` and injected as a
user message with `isMeta: true`:

```
<system-reminder>
<new-diagnostics>The following new diagnostic issues were detected:

main.py:
  ✗ [Line 15:4] Expected str, got int [typo] (pyright)
  ⚠ [Line 22:10] Unused variable [unused] (mypy)</new-diagnostics>
</system-reminder>
```

### Exact formatting function

```typescript
static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
  const truncationMarker = '…[truncated]'
  const result = files
    .map(file => {
      const filename = file.uri.split('/').pop() || file.uri
      const diagnostics = file.diagnostics
        .map(d => {
          const severitySymbol = DiagnosticTrackingService.getSeveritySymbol(d.severity)
          return `  ${severitySymbol} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
        })
        .join('\n')
      return `${filename}:\n${diagnostics}`
    })
    .join('\n\n')

  if (result.length > 4000) {
    return result.slice(0, 4000 - truncationMarker.length) + truncationMarker
  }
  return result
}
```

Severity symbols (from `figures` package):
- Error → `✗` (figures.cross)
- Warning → `⚠` (figures.warning)
- Info → `ℹ` (figures.info)
- Hint → `★` (figures.star)

### Baseline diffing logic

```typescript
// For each file with a baseline:
const newDiagnostics = currentDiagnostics.filter(
  d => !baselineDiagnostics.some(b => areDiagnosticsEqual(d, b))
)

// Two diagnostics are "equal" if ALL of these match:
// - message, severity, source, code
// - range.start.line, range.start.character
// - range.end.line, range.end.character
```

### When things happen

| Hook point | Claude Code | What happens |
|---|---|---|
| `REPL query start` | `handleQueryStart()` | Reset baselines for new query |
| `FileEditTool.execute()` line 425 | `beforeFileEdited(path)` | Capture baseline BEFORE edit |
| `FileWriteTool.execute()` line 247 | `beforeFileEdited(path)` | Capture baseline BEFORE edit |
| `getDiagnosticAttachments()` | `getNewDiagnostics()` | Fetch current, diff, return new |
| Message rendering | `formatDiagnosticsSummary()` | Format as text |
| Attachment injection | `<new-diagnostics>` tag | Wrap in system-reminder |

---

## 2. JetBrains MCP `get_file_problems` Tool

### Endpoint discovery

The JetBrains MCP server config lives in `.pi/mcp.json`:

```json
{
  "mcpServers": {
    "jetbrains": {
      "url": "http://127.0.0.1:64342/sse",
      "headers": {},
      "directTools": true
    }
  }
}
```

### Tool signature (from JetBrains docs)

**`get_file_problems`**

Analyzes the specified file for errors and warnings using IntelliJ inspections.
Returns a list of problems, including severity, description, and location.
Line and column numbers are 1-based.

Parameters:
- `filePath` (string): Path relative to the project root
- `errorsOnly` (boolean): Whether to include only errors or both errors and warnings
- `timeout` (number, optional): Timeout in milliseconds
- `projectPath` (string): The project path

### Expected response format

The MCP tool returns a JSON-RPC result with content blocks. Typical shape:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 2 problems in src/main.py:\n\n1. Error at line 15, column 4: Expected 'str', got 'int' (pyright)\n2. Warning at line 22, column 10: Unused variable 'x' (pyright)"
    }
  ]
}
```

**Important**: The JetBrains response format is NOT the same as Claude Code's
`getDiagnostics` response. We need to **parse** the JetBrains text response and
**map it** to the `Diagnostic`/`DiagnosticFile` format that Claude Code uses.

We'll need to reverse-engineer the exact response format from a live server.
The response likely contains structured data we can parse, or we may need to
parse the human-readable text.

### Other available JetBrains MCP tools (for reference)

- `search_in_files_by_text` — text search
- `search_in_files_by_regex` — regex search
- `get_symbol_info` — symbol at position
- `rename_refactoring` — rename symbol
- `open_file_in_editor` — open file in IDE
- `replace_text_in_file` — edit file via IDE
- `get_file_text_by_path` — read file via IDE
- `find_files_by_glob` / `find_files_by_name_keyword` — file search
- `list_directory_tree` — directory listing
- `reformat_file` — format file
- `execute_terminal_command` — run terminal

---

## 3. Implementation Plan

### Architecture

```
jetbrains-symbol-nudge.ts
  │
  ├── McpProblemsClient (NEW)
  │   - Reads .pi/mcp.json to find JetBrains SSE URL
  │   - Opens SSE connection to JetBrains MCP server
  │   - Calls get_file_problems via JSON-RPC
  │   - Parses response → Diagnostic/DiagnosticFile types
  │   - Caches connection for session lifetime
  │
  ├── ProblemsTracker (NEW)
  │   - baseline: Map<normalizedPath, Diagnostic[]>
  │   - beforeFileEdited(path) → fetch problems → store baseline
  │   - getNewProblems(editedPaths[]) → fetch problems → diff → return new
  │   - formatDiagnosticsSummary(files) → exact Claude Code format
  │   - reset() per turn, shutdown() per session
  │
  └── Existing nudge logic (enhanced)
      - tool_call: intercept edit/write → beforeFileEdited()
      - tool_result: intercept edit/write result → trigger getNewProblems()
      - Inject <new-diagnostics> via pi.sendUserMessage({ deliverAs: "steer" })
      - Keep existing symbol nudge and problems nudge as fallback
```

### Step-by-step

#### Step 1: MCP SSE Client

Create a lightweight MCP SSE client that connects to the JetBrains server.

```typescript
class McpProblemsClient {
  private sseUrl: string;
  private messageEndpoint: string | null = null;
  private eventSource: EventSource | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();

  async connect(): Promise<void> {
    // 1. Open EventSource to sseUrl
    // 2. Listen for "endpoint" event → store messageEndpoint
    // 3. Listen for "message" events → route JSON-RPC responses to pendingRequests
    // 4. Wait for endpoint event (connection ready)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // 1. Generate request ID
    // 2. POST JSON-RPC to messageEndpoint
    //    {
    //      "jsonrpc": "2.0",
    //      "id": requestId,
    //      "method": "tools/call",
    //      "params": { "name": name, "arguments": args }
    //    }
    // 3. Return promise that resolves when SSE response arrives
  }

  async getFileProblems(filePath: string, projectPath: string): Promise<DiagnosticFile | null> {
    const result = await this.callTool("get_file_problems", {
      filePath,
      projectPath,
      errorsOnly: false,
    });
    return this.parseProblemsResponse(filePath, result);
  }

  async shutdown(): Promise<void> {
    this.eventSource?.close();
    this.pendingRequests.clear();
  }
}
```

**Config discovery**: Read `.pi/mcp.json` from `ctx.cwd` or `~/.pi/agent/mcp.json`,
look for a server entry with `url` containing `/sse` and a name like `jetbrains`.

#### Step 2: JetBrains response → Diagnostic mapping

```typescript
function parseProblemsResponse(
  filePath: string,
  mcpResult: unknown,
): DiagnosticFile | null {
  // MCP result shape: { content: [{ type: "text", text: "..." }] }
  const content = (mcpResult as any)?.content;
  if (!Array.isArray(content)) return null;

  const textBlock = content.find((b: any) => b.type === "text");
  if (!textBlock?.text) return null;

  // Parse the JetBrains text response into Diagnostic[]
  // We need to discover the exact format from a live server.
  // Common formats:
  //
  // Option A: Plain text with structured patterns:
  //   "Error at line 15, column 4: Expected 'str', got 'int' (pyright)"
  //
  // Option B: JSON embedded in text
  //
  // Option C: Markdown-like structured text
  //
  // For now, implement a flexible parser that handles common patterns.

  const diagnostics = parseProblemsText(textBlock.text);

  return {
    uri: filePath,
    diagnostics,
  };
}
```

**CRITICAL**: We need to test against a live JetBrains MCP server to discover
the exact response format. The parser must be adapted to match.

#### Step 3: Problems Tracker (mirrors DiagnosticTrackingService)

```typescript
class ProblemsTracker {
  private baseline = new Map<string, Diagnostic[]>();
  private client: McpProblemsClient | null = null;

  async initialize(cwd: string): Promise<boolean> {
    // 1. Find JetBrains MCP config from .pi/mcp.json
    // 2. Create McpProblemsClient and connect
    // 3. Return true if connected, false otherwise
  }

  async beforeFileEdited(filePath: string, cwd: string): Promise<void> {
    if (!this.client) return;

    try {
      const relativePath = path.relative(cwd, filePath);
      const result = await this.client.getFileProblems(relativePath, cwd);

      const normalizedPath = normalizePath(filePath);
      if (result) {
        this.baseline.set(normalizedPath, result.diagnostics);
      } else {
        this.baseline.set(normalizedPath, []);
      }
    } catch {
      // Fail silently — don't block edits
    }
  }

  async getNewProblems(editedPaths: string[], cwd: string): Promise<DiagnosticFile[]> {
    if (!this.client) return [];

    const newProblems: DiagnosticFile[] = [];

    for (const filePath of editedPaths) {
      const normalizedPath = normalizePath(filePath);
      const baselineDiagnostics = this.baseline.get(normalizedPath);

      // Only check files we have baselines for
      if (baselineDiagnostics === undefined) continue;

      try {
        const relativePath = path.relative(cwd, filePath);
        const result = await this.client.getFileProblems(relativePath, cwd);

        if (!result) continue;

        const newDiagnostics = result.diagnostics.filter(
          d => !baselineDiagnostics.some(b => areDiagnosticsEqual(d, b))
        );

        if (newDiagnostics.length > 0) {
          newProblems.push({
            uri: filePath,
            diagnostics: newDiagnostics,
          });
        }

        // Update baseline
        this.baseline.set(normalizedPath, result.diagnostics);
      } catch {
        // Skip files that fail
      }
    }

    return newProblems;
  }

  reset(): void {
    this.baseline.clear();
  }

  async shutdown(): Promise<void> {
    this.reset();
    await this.client?.shutdown();
    this.client = null;
  }
}
```

#### Step 4: Event hooks

```typescript
const tracker = new ProblemsTracker();
const editedFilesThisTurn: string[] = [];

// Session lifecycle
pi.on("session_start", async (_event, ctx) => {
  resetSessionState();
  editedFilesThisTurn.length = 0;

  // Initialize problems tracker
  const connected = await tracker.initialize(ctx.cwd);
  if (connected && ctx.hasUI) {
    ctx.ui.notify("🔍 JetBrains problems tracker connected", "info");
  }
});

pi.on("session_shutdown", async () => {
  await tracker.shutdown();
});

pi.on("turn_start", () => {
  resetRunState();
  editedFilesThisTurn.length = 0;
  tracker.reset();
});

// Pre-edit baseline capture
pi.on("tool_call", async (event, ctx) => {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const effectiveToolName = resolveEffectiveToolName({ toolName: event.toolName, input });

  // BEFORE the edit executes, capture baseline
  if (effectiveToolName === "edit" || effectiveToolName === "write") {
    const filePath = input.file_path || input.path;
    if (typeof filePath === "string") {
      const absolutePath = path.resolve(ctx.cwd, filePath);
      editedFilesThisTurn.push(absolutePath);

      // Fire-and-forget baseline capture (don't block the edit)
      void tracker.beforeFileEdited(absolutePath, ctx.cwd);
    }
  }

  // ... existing nudge logic continues ...
});

// Post-edit problem detection
pi.on("turn_end", async (_event, ctx) => {
  if (editedFilesThisTurn.length === 0) return;
  if (!tracker.isInitialized()) return;

  try {
    const newProblems = await tracker.getNewProblems(editedFilesThisTurn, ctx.cwd);

    if (newProblems.length > 0) {
      const summary = formatDiagnosticsSummary(newProblems);

      // Exact same format as Claude Code
      const message = `<new-diagnostics>The following new diagnostic issues were detected:\n\n${summary}</new-diagnostics>`;

      pi.sendUserMessage(wrapSystemReminder(message), { deliverAs: "steer" });

      if (ctx.hasUI) {
        const totalIssues = newProblems.reduce((sum, f) => sum + f.diagnostics.length, 0);
        ctx.ui.notify(
          `🔍 Found ${totalIssues} new problem(s) in ${newProblems.length} file(s)`,
          "warning",
        );
      }
    }
  } catch {
    // Fail silently
  }

  editedFilesThisTurn.length = 0;
});
```

#### Step 5: Exact formatting (copy from Claude Code)

```typescript
const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000;

function formatDiagnosticsSummary(files: DiagnosticFile[]): string {
  const truncationMarker = "…[truncated]";
  const result = files
    .map((file) => {
      const filename = file.uri.split("/").pop() || file.uri;
      const diagnostics = file.diagnostics
        .map((d) => {
          const severitySymbol = getSeveritySymbol(d.severity);
          return `  ${severitySymbol} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ""}${d.source ? ` (${d.source})` : ""}`;
        })
        .join("\n");

      return `${filename}:\n${diagnostics}`;
    })
    .join("\n\n");

  if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
    return result.slice(0, MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length) + truncationMarker;
  }
  return result;
}

function getSeveritySymbol(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case "Error": return "✗";
    case "Warning": return "⚠";
    case "Info": return "ℹ";
    case "Hint": return "★";
    default: return "•";
  }
}
```

#### Step 6: Diagnostic equality (exact copy)

```typescript
function areDiagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
  return (
    a.message === b.message
    && a.severity === b.severity
    && a.source === b.source
    && a.code === b.code
    && a.range.start.line === b.range.start.line
    && a.range.start.character === b.range.start.character
    && a.range.end.line === b.range.end.line
    && a.range.end.character === b.range.end.character
  );
}
```

---

## 4. SSE MCP Protocol Details

The JetBrains MCP server uses standard MCP over SSE:

### Connection

```
1. GET http://127.0.0.1:64342/sse
   → EventSource connection opens
   → Server sends "endpoint" event with the message POST URL:
     event: endpoint
     data: /message?sessionId=abc123

2. To call a tool:
   POST http://127.0.0.1:64342/message?sessionId=abc123
   Content-Type: application/json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "get_file_problems",
       "arguments": {
         "filePath": "src/main.py",
         "projectPath": "/home/user/project",
         "errorsOnly": false
       }
     }
   }

3. Response comes via SSE stream:
   event: message
   data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}]}}
```

### Node.js EventSource

Node.js 22 has built-in `EventSource`. For older versions, use the `eventsource`
npm package or `undici`'s EventSource.

```typescript
// Node 22+ built-in
const es = new EventSource("http://127.0.0.1:64342/sse");
es.addEventListener("endpoint", (e) => {
  messageEndpoint = new URL(e.data, "http://127.0.0.1:64342/sse").href;
});
es.addEventListener("message", (e) => {
  const response = JSON.parse(e.data);
  const pending = pendingRequests.get(response.id);
  if (pending) {
    pendingRequests.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  }
});
```

---

## 5. Unknown — Needs Live Testing

These things need to be verified against a running JetBrains IDE:

1. **Exact `get_file_problems` response format** — we need to see the actual text
   in the MCP result content block. Is it structured JSON, plain text, or markdown?

2. **Severity mapping** — JetBrains uses its own severity levels. We need to map:
   - `ERROR` → `Error`
   - `WARNING` → `Warning`
   - `INFO` → `Info`
   - `HINT` → `Hint`

3. **Path format** — does JetBrains return relative or absolute paths?

4. **Latency** — how fast is `get_file_problems`? If it's >500ms we may need to
   run baseline capture async and not await it.

5. **Project path parameter** — what value does JetBrains expect? Absolute path
   to project root? Relative?

6. **SSE session management** — does the session timeout? Do we need heartbeats?

---

## 6. Implementation Order

1. **McpProblemsClient** — SSE connection + JSON-RPC tool calling
2. **Response parser** — parse `get_file_problems` response → `Diagnostic[]`
3. **ProblemsTracker** — baseline capture + diffing logic
4. **Event hooks** — wire into `tool_call` (pre-edit) and `turn_end` (post-edit)
5. **Injection** — format as `<new-diagnostics>` and send via `pi.sendUserMessage`
6. **Testing** — verify against live JetBrains IDE
7. **Fallback** — keep existing nudge logic for when MCP is unavailable
8. **Status command** — update `/jetbrains-nudge` to show tracker state

---

## 7. File Structure

The entire implementation goes in a single file (existing extension):

```
/home/ineersa/claw/my-pi/.pi/extensions/jetbrains-symbol-nudge.ts
```

If it gets too large, split into a directory:

```
/home/ineersa/claw/my-pi/.pi/extensions/jetbrains-symbol-nudge/
├── index.ts          — main extension, event hooks, nudge logic
├── mcp-client.ts     — McpProblemsClient (SSE + JSON-RPC)
├── problems.ts       — ProblemsTracker, types, formatting
└── package.json      — if we need npm deps (eventsource polyfill)
```

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| JetBrains MCP not running | Gracefully fall back to nudge-only mode |
| SSE connection drops | Reconnect on next `tool_call` or `turn_start` |
| `get_file_problems` is slow | Run baseline capture async, don't block edits |
| Response format varies across IDEs | Flexible parser with fallback to raw text |
| Extension blocks edit tool call | `beforeFileEdited` is fire-and-forget (void, not awaited) |
| Too many problems reported | Truncate at 4000 chars, same as Claude Code |
| JetBrains MCP port changes | Re-read config from `.pi/mcp.json` each session |
