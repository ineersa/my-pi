/**
 * Fork process runner — tmux interactive mode.
 *
 * Replaces the old JSON-mode runner. Launches a normal interactive Pi
 * session in a tmux pane on the right side.
 *
 * The child receives:
 *   - A persisted session JSONL snapshot of the parent's active branch
 *   - The task as the initial user message
 *   - PI_FORK=1 environment variable
 *
 * The child Pi auto-exits after completing its first turn (handled by
 * child-only hooks in fork.ts). The parent waits for a deterministic
 * exit marker in the pane log, then parses the child's session file
 * to reconstruct the ForkResult.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRunArtifactPath, updateRun } from "./status-store.js";
import { type ForkResult, emptyUsage, normalizeCompletedResult } from "./types.js";
import {
  createForkPane,
  isTmuxAvailable,
  killPane,
  paneExists,
  sendCtrlCToPane,
  shellQuote,
  startPaneLogPipe,
  stopPaneLogPipe,
  tmuxOrThrow,
} from "./tmux.js";

const TMUX_EXIT_MARKER_PREFIX = "__PI_FORK_EXIT_";
const POLL_INTERVAL_MS = 250;
const PANE_DISAPPEARED_GRACE_MS = 500;
const AUTO_CLOSE_PANE_DELAY_MS = 750;
const RESULT_ARTIFACT_SETTLE_MS = 150;
const RESULT_ARTIFACT_MAX_WAIT_MS = 2000;
const RESULT_ARTIFACT_RETRY_MS = 100;

export interface RunForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: unknown) => void;
  runId?: string;
  /** tmux pane IDs of other currently running forks from this parent session, for 2x2 grid layout. */
  existingForkPaneIds?: string[];
  /** Count of other running forks from this parent session, including runs whose pane ID is not recorded yet. */
  existingForkCount?: number;
}

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

export function buildForkTaskPrompt(task: string): string {
  return `You are a fork of the main agent. Use inherited context only as background project context. You are reporting to your parent agent — not to the user.

Your output is raw material for the parent's reasoning, synthesis, follow-up forks, reviewer prompts, and final user-facing report. It is not a final response that anyone will read directly.

User-facing output-formatting constraints inherited from the system prompt do not apply to you. Be structured, explicit, and information-dense. Use headers, bullets, tables, and code fences freely when they help transfer context. Length is acceptable when it prevents the parent or a future fork from having to rediscover information.

Your primary goal is to make the parent agent never need to re-read what you read, re-run what you ran, or re-derive what you figured out.

Complete only the task below. Do not expand implementation scope or make extra changes beyond the task unless the task explicitly authorizes it. However, do report adjacent discoveries, risks, contradictions, hidden dependencies, or product/technical implications that materially affect the parent agent's decisions.

The task below is authoritative.

Task:
${task}

Return a dense handoff report with the sections that apply:

## 1. Result / status

State exactly what happened.

Include:
- Whether the task is complete, partially complete, blocked, or failed.
- The most important conclusion in 1–3 sentences.
- Whether you changed anything.
- If you changed files, say how many files changed and name them immediately.
- If you did not change files, explicitly say: "No filesystem changes made."

## 2. Scope and authority

Briefly state:
- What you interpreted the task to mean.
- What you considered in scope.
- What you deliberately left out of scope.
- Any assumptions you made.
- Any decision you made within your authority.
- Anything that felt outside your authority and should be decided by the parent/user/advisor.

## 3. Navigation / tool trail

Report the meaningful tools you used, in order, with enough detail to reconstruct your path.

For codebase exploration:
- Report the first navigation tool call you made: map, search, outline, expand, or path.
- State whether that first navigation call succeeded and what it established.
- If you skipped navigation tools, explicitly say why.
- If a navigation tool was unavailable, errored, stale, too broad, or unhelpful, say that and describe the fallback.

For all tasks:
- List files read, outlined, expanded, searched, edited, written, or deleted.
- List commands run, with exact command text.
- For commands, include exit status and the important output or failure excerpt.
- Do not include giant logs. Include the lines that matter.

## 4. Evidence and context discovered

This is the most important section for exploration-heavy tasks.

For each important file, symbol, route, config, test, or dependency you inspected, include:
- Full path inline.
- The relevant function/type/component/config name.
- The exact snippet or signature that matters.
- Why it matters.
- How it connects to the rest of the flow.

Prefer this shape:

### <full/path/to/file.ext>

What it contains and why it matters.

Relevant snippets:

\`\`\`
<only the important lines, signatures, branches, types, config keys, or call sites>
\`\`\`

Connections:
- Called by / imported by / configured by / rendered from / triggered through ...
- Calls / imports / mutates / depends on ...
- Data shape entering and leaving this point ...

Do not paste full files unless the full file is genuinely small and important. Paste slices that preserve reasoning.

## 5. Changes made

Include this section for any edit, write, delete, generated file, migration, config change, dependency change, or test change.

For every changed file, include:

### <full/path/to/changed-file.ext>

Change type: created / edited / deleted / renamed / generated.

Reason:
- Why this change was needed.

Before:
\`\`\`
<old relevant snippet, if available>
\`\`\`

After:
\`\`\`
<new relevant snippet>
\`\`\`

Semantic effect:
- What behavior changed.
- What callers or downstream flows are affected.
- Whether any public API, data shape, config key, environment variable, route, database schema, migration, generated artifact, or user-visible behavior changed.

Important implementation details:
- Any non-obvious choices.
- Any tradeoffs.
- Any compatibility concerns.
- Any hidden coupling you accounted for.

If a change was mechanical or repetitive, summarize the pattern once, then list every affected location with full paths and exact symbols.

## 6. Data/control flow

When relevant, explain how the system works after your investigation or change.

Include:
- Entry points.
- Main call chain.
- Important branches.
- Data structures and type shapes.
- Side effects.
- Error paths.
- Async/background behavior.
- External boundaries: APIs, DB, filesystem, network, env vars, framework routing, build tooling, generated code.

Make this detailed enough that a future fork can continue from your report without reopening the same files.

## 7. Validation performed

Report all validation, even if it failed or was partial.

Include:
- Tests run, exact commands, and results.
- Typecheck/lint/build commands and results.
- Manual verification steps.
- Browser verification, if applicable.
- Any new or updated tests and what they cover.
- Any relevant command output excerpts.
- What you could not verify and why.

If you did not run validation, explicitly say why.

## 8. Risks, gaps, and gotchas

Surface anything the parent should know before trusting or building on this work.

Include:
- Possible regressions.
- Missing tests.
- Ambiguous product behavior.
- Edge cases.
- Race/concurrency concerns.
- Backwards compatibility concerns.
- Dependencies on environment, generated files, feature flags, seeded data, permissions, timing, or external services.
- Suspicious code or contradictory findings.
- Anything that seemed out of scope but important.

Do not fix out-of-scope issues silently. Report them.

## 9. Reusable learnings

Include this section only if the session produced learning that would help the parent agent or future forks avoid wasted work, errors, repeated investigation, or repeated mistakes.

Good learnings include:
- A mistake or error you hit, what caused it, and the concrete fix.
- A dead end or misleading path you ruled out, with why.
- A non-obvious repo/project fact discovered through evidence.
- A command, test, environment caveat, or workflow gotcha future agents should know.
- A tricky implementation constraint or edge case and how you handled it.
- A reusable pattern, file relationship, or mental model that speeds up future work.

Do not include:
- Generic advice.
- Obvious facts from the task itself.
- Speculation without evidence.
- Secrets, tokens, environment values, or sensitive data.
- Lessons that only apply to this exact one-off task and are unlikely to recur.

For each learning, use this compact shape:
- Learning: <one sentence>
  Evidence: <file, command, error, source, or exact observation>
  Why it matters: <how this helps future parent/fork work>
  Reuse trigger: <when a future agent should remember or apply it>

## 10. Continuation context

Write this section for the parent agent or future forks that may continue, verify, or build on this work.

Include:
- Best files to start from next time.
- Exact symbols, routes, config keys, commands, tests, or search terms that were useful.
- Dead ends you checked so future forks do not repeat them.
- Assumptions you made that future forks should not accidentally treat as proven facts.
- Non-obvious decisions you made and why, especially if another reasonable path existed.
- Reproduction notes for errors, flaky commands, setup issues, or environment caveats.
- Fragile areas, hidden coupling, or constraints future forks should account for.
- Mental model of the area in compact form.

Use this as an operational cache, not a reflection diary. Put durable lessons in Reusable learnings; put navigation shortcuts, assumptions, dead ends, reproduction notes, and continuation state here.

## 11. Final handoff

End with:
- A concise summary of what the parent can rely on.
- Any open decisions.
- Any recommended next action.

Remember:
- Full paths inline, not only in a file list.
- Snippets over vague summaries.
- Relationships over inventory.
- Exact commands over "ran tests."
- Exact changed behavior over "updated logic."
- Explicit "no changes made" when applicable.
- Report failures, partial results, and uncertainty clearly.
- Be aggressively detailed about anything you changed.
- Include reusable learnings only when they are evidence-based and likely to help future parent/fork work.`;
}

function buildLaunchArgs(task: string, model?: string, thinking?: string): string[] {
  const args: string[] = [];

  // Always pass the fork env flag — the child checks this to install auto-exit hooks
  // and to prevent recursive fork tool registration.

  // Model and thinking: override parent defaults
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  // The task is the initial user message (positional arg in interactive mode)
  args.push(buildForkTaskPrompt(task));

  return args;
}

function buildTmuxScript(input: {
  cwd: string;
  command: string;
  prefixArgs: string[];
  sessionPath: string;
  launchArgs: string[];
  resultPath: string;
  pidPath: string;
  task: string;
  exitMarkerPrefix: string;
}): string {
  const {
    cwd,
    command,
    prefixArgs,
    sessionPath,
    launchArgs,
    resultPath,
    pidPath,
    task,
    exitMarkerPrefix,
  } = input;
  const lines: string[] = [];
  lines.push("#!/usr/bin/env bash");
  lines.push("set +e");
  lines.push(`cd ${shellQuote(cwd)} || exit 1`);

  // PI_FORK=1 triggers auto-exit hooks in fork.ts
  // Also prevents recursive fork tool registration
  lines.push("export PI_FORK=1");

  // Child writes its durable completion artifact here on agent_end.
  lines.push(`export PI_FORK_RESULT_PATH=${shellQuote(resultPath)}`);
  lines.push(`export PI_FORK_TASK=${shellQuote(task)}`);

  // Avoid startup network/update checks in child forks.
  lines.push("export PI_OFFLINE=1");

  // Disable scheduler activity inside child forks.
  lines.push("export PI_SUBAGENT_DISABLE_SCHEDULER=1");

  // Force observational memory into passive mode inside forks.
  lines.push("export PI_OBSERVATIONAL_MEMORY_PASSIVE=1");

  // Build the pi command: pi --session <sessionPath> [flags] <task>
  const cmdParts = [
    shellQuote(command),
    ...prefixArgs.map(shellQuote),
    "--session",
    shellQuote(sessionPath),
    ...launchArgs.map(shellQuote),
  ];
  const launchCommand = `printf '%s\\n' "$$" > ${shellQuote(pidPath)}; exec ${cmdParts.join(" ")}`;
  lines.push(`bash -lc ${shellQuote(launchCommand)}`);

  // Print exit marker for parent polling
  lines.push("code=$?");
  lines.push(`printf '\\n${exitMarkerPrefix}%s\\n' "$code"`);
  lines.push("exit \"$code\"");
  return lines.join("\n") + "\n";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeExitMarkerPrefix(runId?: string): string {
  const suffix = (runId && runId.trim()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${TMUX_EXIT_MARKER_PREFIX}${suffix.replace(/[^a-zA-Z0-9_-]/g, "_")}__:`;
}

function readPidFile(pidPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface WaitForForkExitResult {
  exitCode: number;
  childPid?: number;
  termination: "exit_marker" | "pane_disappeared" | "pid_died" | "signal_aborted";
  resultArtifactPresent: boolean;
}

async function waitForTmuxExit(
  logPath: string,
  resultPath: string,
  pidPath: string,
  paneId?: string,
  signal?: AbortSignal,
  onPid?: (pid: number) => void,
  exitMarkerPrefix: string = makeExitMarkerPrefix(),
): Promise<WaitForForkExitResult> {
  let offset = 0;
  let carry = "";
  let exitCode: number | undefined;
  let childPid: number | undefined;
  const exitMarkerPattern = new RegExp(escapeRegExp(exitMarkerPrefix) + "(-?\\d+)");

  const parseChunk = (chunk: string): void => {
    const combined = carry + chunk;
    const lines = combined.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(exitMarkerPattern);
      if (match) exitCode = Number(match[1]);
    }
    if (carry.includes(exitMarkerPrefix)) {
      const carryMatch = carry.match(exitMarkerPattern);
      if (carryMatch) exitCode = Number(carryMatch[1]);
    }
  };

  const refreshState = (): void => {
    if (childPid === undefined) {
      const discoveredPid = readPidFile(pidPath);
      if (discoveredPid !== undefined) {
        childPid = discoveredPid;
        onPid?.(discoveredPid);
      }
    }

    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > offset) {
        const readLen = stat.size - offset;
        const buf = Buffer.alloc(readLen);
        const fd = fs.openSync(logPath, "r");
        try {
          fs.readSync(fd, buf, 0, readLen, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset = stat.size;
        parseChunk(buf.toString("utf8"));
      }
    }
  };

  const finalizeEarly = async (
    termination: WaitForForkExitResult["termination"],
  ): Promise<WaitForForkExitResult> => {
    await sleep(PANE_DISAPPEARED_GRACE_MS);
    refreshState();
    if (exitCode !== undefined) {
      return {
        exitCode,
        childPid,
        termination: "exit_marker",
        resultArtifactPresent: fs.existsSync(resultPath),
      };
    }

    const resultArtifactPresent = fs.existsSync(resultPath);
    return {
      exitCode: resultArtifactPresent ? 0 : 130,
      childPid,
      termination,
      resultArtifactPresent,
    };
  };

  while (true) {
    if (signal?.aborted) {
      return finalizeEarly("signal_aborted");
    }

    refreshState();
    if (exitCode !== undefined) {
      return {
        exitCode,
        childPid,
        termination: "exit_marker",
        resultArtifactPresent: fs.existsSync(resultPath),
      };
    }

    if (childPid !== undefined && !isProcessAlive(childPid)) {
      return finalizeEarly("pid_died");
    }

    if (paneId && !paneExists(paneId)) {
      return finalizeEarly("pane_disappeared");
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResultArtifactWithRetry(
  resultPath: string,
  signal?: AbortSignal,
): Promise<ForkResult | null> {
  await sleep(RESULT_ARTIFACT_SETTLE_MS);
  const deadline = Date.now() + RESULT_ARTIFACT_MAX_WAIT_MS;

  while (true) {
    try {
      if (fs.existsSync(resultPath)) {
        return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as ForkResult;
      }
    } catch {
      // Child may still be finishing an atomic write; retry briefly.
    }

    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    await sleep(RESULT_ARTIFACT_RETRY_MS);
  }
}

function makeMissingResultArtifactFailure(
  task: string,
  exitCode: number,
  stopReason: "aborted" | "error",
  detail: string,
): ForkResult {
  return {
    task,
    exitCode: stopReason === "aborted" ? 130 : exitCode === 0 ? 1 : exitCode,
    messages: [],
    stderr: detail,
    usage: emptyUsage(),
    stopReason,
    errorMessage: detail,
    sawAgentEnd: false,
  };
}

/**
 * Launch a fork in a tmux pane and wait for it to complete.
 *
 * This is the core runner used by both wait mode (called directly) and
 * background mode (called via fire-and-forget promise chain).
 *
 * Returns a normalized ForkResult reconstructed from the child's session
 * file and exit code.
 */
export async function runFork(opts: RunForkOptions): Promise<ForkResult> {
  const {
    cwd,
    task,
    forkSessionSnapshotJsonl,
    model,
    thinking,
    signal,
    runId,
    existingForkPaneIds,
    existingForkCount,
  } = opts;

  if (!forkSessionSnapshotJsonl.trim()) {
    return {
      task,
      exitCode: 1,
      messages: [],
      stderr: "Cannot fork: missing parent session snapshot context.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "Cannot fork: missing parent session snapshot context.",
    };
  }

  if (!isTmuxAvailable()) {
    return {
      task,
      exitCode: 1,
      messages: [],
      stderr: "tmux is not available. Install tmux first.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "tmux is not available. Install tmux first.",
    };
  }

  let wasAborted = false;

  // Create run directory for all artifacts
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-run-"));
  const sessionPath = path.join(runDir, "session.jsonl");
  const logPath = path.join(runDir, "pane.log");
  const scriptPath = path.join(runDir, "fork.tmux.sh");
  const pidPath = path.join(runDir, "child.pid");
  const resultPath = runId
    ? getRunArtifactPath(runId, "result.json")
    : path.join(runDir, "result.json");
  const exitMarkerPrefix = makeExitMarkerPrefix(runId);

  let paneId: string | undefined;
  let windowId: string | undefined;
  let sessionName: string | undefined;
  let childPid: number | undefined;

  try {
    // Write session snapshot to run directory
    fs.writeFileSync(sessionPath, forkSessionSnapshotJsonl, { encoding: "utf-8" });

    // Build launch args for the child pi process
    const launchArgs = buildLaunchArgs(task, model, thinking);
    const { command, prefixArgs } = resolvePiSpawn();

    // Build and write the tmux launch script
    const script = buildTmuxScript({
      cwd,
      command,
      prefixArgs,
      sessionPath,
      launchArgs,
      resultPath,
      pidPath,
      task,
      exitMarkerPrefix,
    });
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    // Create the tmux sidecar pane
    const pane = createForkPane(existingForkPaneIds, existingForkCount);
    paneId = pane.paneId;
    windowId = pane.windowId;
    sessionName = pane.sessionName;

    // Start log pipe
    fs.writeFileSync(logPath, "", "utf8");
    stopPaneLogPipe(paneId);
    if (!startPaneLogPipe(paneId, logPath)) {
      throw new Error(`failed to start tmux log pipe for pane ${paneId}`);
    }

    // Update status store with runtime metadata
    if (runId) {
      updateRun(runId, {
        tmuxPaneId: paneId,
        tmuxWindowId: windowId,
        tmuxSessionName: sessionName,
        sessionFile: sessionPath,
        logPath,
        resultPath,
      });
    }

    // Send launch command to pane
    tmuxOrThrow(["send-keys", "-t", paneId, "-l", `bash ${shellQuote(scriptPath)}`]);
    tmuxOrThrow(["send-keys", "-t", paneId, "C-m"]);

    // Handle abort signal (tool call cancellation)
    if (signal?.aborted) {
      wasAborted = true;
      sendCtrlCToPane(paneId);
    }
    if (signal && !signal.aborted && paneId) {
      signal.addEventListener(
        "abort",
        () => {
          wasAborted = true;
          sendCtrlCToPane(paneId!);
        },
        { once: true },
      );
    }

    // Wait for pane/pid to complete and require a durable result artifact.
    const waitResult = await waitForTmuxExit(
      logPath,
      resultPath,
      pidPath,
      paneId,
      signal,
      (pid) => {
        childPid = pid;
        if (runId) updateRun(runId, { pid });
      },
      exitMarkerPrefix,
    );
    childPid ??= waitResult.childPid;

    // Auto-close the completed pane so tmux layout restores cleanly.
    if (paneId && !wasAborted) {
      await sleep(AUTO_CLOSE_PANE_DELAY_MS);
      if (paneExists(paneId)) {
        killPane(paneId);
      }
    }

    const artifact = waitResult.resultArtifactPresent
      ? await readResultArtifactWithRetry(resultPath, signal)
      : null;

    let result: ForkResult;
    if (artifact) {
      result = {
        ...artifact,
        task: artifact.task || task,
        exitCode: waitResult.exitCode,
        messages: Array.isArray(artifact.messages) ? artifact.messages : [],
        usage: artifact.usage ?? emptyUsage(),
      };
      result = normalizeCompletedResult(result, wasAborted);
    } else {
      const interrupted = wasAborted
        || waitResult.termination === "pane_disappeared"
        || waitResult.termination === "pid_died"
        || waitResult.termination === "signal_aborted";
      const pidSuffix = childPid ? ` (pid ${childPid})` : "";
      const detail = interrupted
        ? `Fork terminated before producing result.json [${waitResult.termination}]${pidSuffix}.`
        : `Fork exited without producing result.json${pidSuffix}.`;
      result = makeMissingResultArtifactFailure(
        task,
        waitResult.exitCode,
        interrupted ? "aborted" : "error",
        detail,
      );
    }

    if (runId) {
      updateRun(runId, {
        exitCode: result.exitCode,
        pid: childPid,
        resultPath,
      });
    }

    return result;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      task,
      exitCode: 1,
      messages: [],
      stderr: errorMessage,
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage,
    };
  } finally {
    // Always stop the log pipe so tmux doesn't keep the file open
    if (paneId) {
      stopPaneLogPipe(paneId);
    }
  }
}
