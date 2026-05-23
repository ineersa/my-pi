/**
 * Pi Fork Extension
 *
 * Provides one tool:
 *   fork({ task, model?, thinking?, background? })
 *
 * Two modes:
 *   - wait mode (default): spawn a tmux fork and wait for completion
 *   - background mode: launch fork, return immediately, get follow-up result
 *
 * The child process receives a persistent JSONL snapshot of the current active
 * session branch, then a normal interactive Pi session processes the task.
 * When PI_FORK=1 is set (child environment), the extension installs auto-exit
 * hooks so the child exits after completing its first full agent response.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { aggregateInclusiveCost, formatForkCostStatus } from "./cost.js";
import { loadConfig } from "./config.js";
import { renderForkCall, renderForkResult } from "./render.js";
import { runFork } from "./runner.js";
import { getResultSummaryText } from "./runner-events.js";
import { makeForkResult, parseSessionResult } from "./session-result.js";
import {
  MAX_CONCURRENT_FORKS,
  createRun,
  completeRun,
  failRun,
  getRunStatus,
  listRuns,
} from "./status-store.js";
import {
  type ForkDetails,
  type ForkResult,
  emptyUsage,
  isResultError,
} from "./types.js";
import { killPane, paneExists } from "./tmux.js";

const ForkRetrieveParams = Type.Object({
  run_id: Type.String({
    description:
      "The run ID of the fork to retrieve results for (e.g. 'zqdlmbeoabc0'). Shown when the fork is launched.",
  }),
});

interface ForkRetrieveToolParams {
  run_id: string;
}

const ForkParams = Type.Object({
  task: Type.String({
    description:
      "The task for the fork to complete. Specify what to do and where the fork's decision authority ends — it will surface ambiguities back to you rather than resolve them on your behalf. The fork already knows to return dense, concrete output with snippets and relationships; you only need to call out anything task-specific about the return shape.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Model/provider string for the fork child, e.g. 'anthropic/claude-sonnet-4'. Overrides pi-fork.defaultModel config.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking level for the fork child: off, minimal, low, medium, high, xhigh. Overrides pi-fork.defaultThinking config.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the fork in background mode. The tool returns immediately. A follow-up will be delivered automatically when the fork finishes. Do not wait for the fork; continue with other work.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the fork child. Defaults to the current session's cwd. Use when running in a git worktree or when the fork should operate in a different directory.",
    }),
  ),
});

interface ForkToolParams {
  task: string;
  model?: string;
  thinking?: string;
  background?: boolean;
  cwd?: string;
}

const FORK_CHILD_SYSTEM_PROMPT = `FORK MODE IS ENABLED.

You are already the forked child agent. Do not behave like the parent agent.

Mandatory rules:
- Your task is defined by the last user message in this session.
- You must execute that task directly and exactly.
- Do not suggest launching a fork.
- Do not attempt to call, inspect, debug, or reason about the fork tool unless the delegated task explicitly requires historical/code investigation of the fork implementation itself.
- Do not treat recent conversation as an instruction to launch or monitor another fork. That orchestration already happened before you started.
- Do not assume you are still in the parent session. You are the fork.
- Do not wait for another agent to act. Complete the delegated task yourself.
- If the task is impossible or ambiguous, say so explicitly and explain why.

Primary operating rule:
- Ignore fork-launch orchestration context and obey the delegated task in the last user message.`;

function collectUsageFromMessages(messages: unknown[]): ReturnType<typeof emptyUsage> {
  const usage = emptyUsage();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const rawUsage = (message as { usage?: unknown }).usage;
    if (!rawUsage || typeof rawUsage !== "object") continue;
    const entryUsage = rawUsage as Record<string, unknown>;
    usage.input += typeof entryUsage.input === "number" ? entryUsage.input : 0;
    usage.output += typeof entryUsage.output === "number" ? entryUsage.output : 0;
    usage.cacheRead += typeof entryUsage.cacheRead === "number" ? entryUsage.cacheRead : 0;
    usage.cacheWrite += typeof entryUsage.cacheWrite === "number" ? entryUsage.cacheWrite : 0;

    const costVal = entryUsage.cost;
    usage.cost += typeof costVal === "number"
      ? costVal
      : typeof costVal === "object" && costVal !== null && typeof (costVal as { total?: unknown }).total === "number"
        ? ((costVal as { total: number }).total)
        : 0;

    usage.turns++;
    usage.contextTokens = Math.max(
      usage.contextTokens,
      typeof entryUsage.totalTokens === "number" ? entryUsage.totalTokens : 0,
      typeof entryUsage.contextTokens === "number" ? entryUsage.contextTokens : 0,
    );
  }
  return usage;
}

function getLastAssistantMetadata(messages: unknown[]): {
  provider?: string;
  model?: string;
  stopReason?: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const candidate = message as {
      role?: unknown;
      provider?: unknown;
      model?: unknown;
      stopReason?: unknown;
    };
    if (candidate.role !== "assistant") continue;
    return {
      provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
      model: typeof candidate.model === "string" ? candidate.model : undefined,
      stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
    };
  }
  return {};
}

function writeForkChildResult(messages: unknown[]): void {
  const resultPath = process.env.PI_FORK_RESULT_PATH?.trim();
  if (!resultPath) return;

  const safeMessages = Array.isArray(messages) ? messages : [];
  const metadata = getLastAssistantMetadata(safeMessages);
  const result: ForkResult = {
    task: process.env.PI_FORK_TASK ?? "",
    exitCode: 0,
    messages: safeMessages as any,
    stderr: "",
    usage: collectUsageFromMessages(safeMessages),
    provider: metadata.provider,
    model: metadata.model,
    stopReason: metadata.stopReason,
    sawAgentEnd: true,
  };

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const tmpPath = `${resultPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2), "utf-8");
  fs.renameSync(tmpPath, resultPath);
}

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function isAssistantForkToolCallEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } }).message;
  const type = (entry as { type?: unknown }).type;
  if (type !== "message" || !message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((part) =>
    part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "toolCall"
    && (part as { name?: unknown }).name === "fork",
  );
}

function isUserMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const message = (entry as { type?: unknown; message?: { role?: unknown } }).message;
  const type = (entry as { type?: unknown }).type;
  return type === "message" && !!message && message.role === "user";
}

function sanitizeForkSnapshotBranch(branchEntries: unknown[]): unknown[] {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (!isAssistantForkToolCallEntry(branchEntries[i])) continue;

    for (let j = i - 1; j >= 0; j--) {
      if (isUserMessageEntry(branchEntries[j])) {
        return branchEntries.slice(0, j);
      }
    }

    return branchEntries.slice(0, i);
  }
  return branchEntries;
}

function makeSyntheticSessionEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function parseModelSpec(model?: string): { provider: string; modelId: string } | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;

  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

function appendForkOverrideEntries(
  branchEntries: unknown[],
  model?: string,
  thinking?: string,
): unknown[] {
  if (!model?.trim() && !thinking?.trim()) return branchEntries;

  const entries = [...branchEntries];
  let parentId: string | undefined;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      parentId = id;
      break;
    }
  }

  const parsedModel = parseModelSpec(model);
  if (parsedModel) {
    const id = makeSyntheticSessionEntryId();
    entries.push({
      type: "model_change",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      provider: parsedModel.provider,
      modelId: parsedModel.modelId,
    });
    parentId = id;
  }

  const trimmedThinking = thinking?.trim();
  if (trimmedThinking) {
    entries.push({
      type: "thinking_level_change",
      id: makeSyntheticSessionEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      thinkingLevel: trimmedThinking,
    });
  }

  return entries;
}

function buildForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
  model?: string,
  thinking?: string,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = appendForkOverrideEntries(
    sanitizeForkSnapshotBranch(sessionManager.getBranch()),
    model,
    thinking,
  );
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function makeDetails(results: ForkResult[]): ForkDetails {
  return { results };
}

function emptyFailedResult(task: string, message: string): ForkResult {
  return {
    task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
  };
}

const FORK_COST_STATUS_KEY = "fork-cost";

function updateForkCostStatus(ctx: ExtensionContext): void {
  if (!loadConfig(ctx.cwd).costFooter) {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    return;
  }

  const stats = aggregateInclusiveCost(ctx.sessionManager.getEntries());
  const status = formatForkCostStatus(stats);
  ctx.ui.setStatus(FORK_COST_STATUS_KEY, status ? ctx.ui.theme.fg("dim", status) : undefined);
}

// ─── Cleanup helpers ───────────────────────────────────────────────

/**
 * Kill any running fork panes/PIDs and mark them as failed.
 * Called during session_shutdown to clean up orphaned background forks.
 */
function cleanupRunningForks(cwd?: string, parentSessionFile?: string | null): void {
  const recent = listRuns(100, cwd);
  for (const run of recent) {
    if (parentSessionFile && run.parentSessionFile !== parentSessionFile) continue;
    if (run.state !== "running") continue;

    // Try pane kill first (most reliable in tmux)
    if (run.tmuxPaneId) {
      try {
        if (paneExists(run.tmuxPaneId)) {
          killPane(run.tmuxPaneId);
        }
      } catch {
        // Pane already gone or tmux unavailable
      }
    }

    // Fall back to PID-based kill
    if (run.pid) {
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // Process already exited
      }
    }

    failRun(run.runId, "Parent session shut down. Fork was aborted.");
  }
}

// ─── Extension entry point ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Child-only hooks (when PI_FORK=1) ──────────────────────────
  //
  // The child runs as a normal interactive Pi. Without these hooks, it
  // would never auto-exit after completing the delegated task. We must
  // wait for the full agent run to finish — not merely the first turn,
  // because a tool-using turn is often followed by a final assistant
  // synthesis turn. `agent_end` is the correct completion hook.
  if (process.env.PI_FORK === "1") {
    let agentCompleted = false;

    pi.on("before_agent_start", (event) => {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${FORK_CHILD_SYSTEM_PROMPT}`,
      };
    });

    pi.on("agent_end", (event) => {
      if (agentCompleted) return;
      agentCompleted = true;

      writeForkChildResult(Array.isArray(event.messages) ? event.messages : []);

      // Small delay to let the result artifact and session file flush to disk, then exit.
      setTimeout(() => {
        process.exit(0);
      }, 300);
    });

    // Safety net: if something goes wrong, don't hang forever.
    pi.on("session_shutdown", () => {
      process.exit(1);
    });

    return;
  }

  // ── Disable guard ──────────────────────────────────────────────
  // When running inside a subagent child, PI_FORK_DISABLE=1 is set to
  // prevent subagents from spawning their own forks (which would create
  // unbounded nesting: subagent → fork → fork → ...).
  if (process.env.PI_FORK_DISABLE === "1") {
    return;
  }

  // ── Parent-only hooks ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    cleanupRunningForks(ctx.cwd, ctx.sessionManager.getSessionFile());
  });

  // ── Fork retrieve tool ──────────────────────────────────────────

  pi.registerTool({
    name: "fork_retrieve",
    label: "Fork Retrieve",
    description:
      "Retrieve the result artifact for a completed or failed fork run by its run ID. " +
      "Use this when a fork's follow-up delivery was missed, corrupted, or when you need to re-read a fork's output. " +
      "Returns the same summary text the fork would have produced on completion.",
    parameters: ForkRetrieveParams as any,

    async execute(_toolCallId, params: ForkRetrieveToolParams, _signal, _onUpdate, _ctx) {
      const runId = params.run_id.trim();
      if (!runId) {
        return {
          content: [{ type: "text" as const, text: "Error: run_id parameter is required." }],
          details: {},
          isError: true,
        };
      }

      const status = getRunStatus(runId);
      if (!status) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No fork run found with ID '${runId}'. Check the ID and try again.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Still running — can't retrieve yet
      if (status.state === "running") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Fork run '${runId}' is still running. Wait for it to complete before retrieving results.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Try to read the result artifact from disk
      const resultPath = status.resultPath;
      if (!resultPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Fork run '${runId}' (state: ${status.state}) has no result artifact path recorded. The run may have been too old or the result was not persisted.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      let resultJson: string;
      try {
        resultJson = fs.readFileSync(resultPath, "utf-8");
      } catch {
        // Result file missing — try session file fallback
        if (status.sessionFile) {
          try {
            const parsed = parseSessionResult(status.sessionFile);
            if (parsed && parsed.finalOutput) {
              const forkResult = makeForkResult(status.task ?? "", parsed, status.exitCode ?? 1);
              return {
                content: [{ type: "text" as const, text: getResultSummaryText(forkResult) }],
                details: makeDetails([forkResult]),
              };
            }
          } catch {
            // Session file also unreadable
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Fork run '${runId}' (state: ${status.state}) — result artifact not found at '${resultPath}'. ${status.error ? `Error: ${status.error}` : "The artifact file may have been cleaned up."}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      let result: ForkResult;
      try {
        result = JSON.parse(resultJson) as ForkResult;
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Fork run '${runId}' — result artifact at '${resultPath}' is corrupted and cannot be parsed.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: getResultSummaryText(result) }],
        details: makeDetails([result]),
      };
    },
  });

  // ── Fork tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: "fork",
    label: "Fork",
    description:
      "Spawn a fork of yourself to handle a focused task. The fork inherits your full session context and works independently — its activity stays out of your context window. " +
      "Forks run in a tmux pane on the right side so you can watch their progress. " +
      "Use background:true to launch without waiting — you will receive a follow-up when it completes. " +
      "Forks return dense, concrete output: the snippets, signatures, and relationships you'd otherwise have to discover yourself, plus anything they found beyond the task that's worth knowing. " +
      "Use cwd to run the fork in a different working directory, e.g. when operating in a git worktree. " +
      "Use for anything that would generate context noise: exploration, implementation, testing, iteration. " +
      "IMPORTANT: Up to 3 forks can run concurrently per working directory. The main Pi stays in the top-left. First fork: right half. Second fork: split right pane (top-right + bottom-right). Third fork: split left pane (2x2 grid). Never launch more than 3 concurrent forks from the same cwd.",
    parameters: ForkParams as any,
    renderCall: renderForkCall,
    renderResult: renderForkResult,

    async execute(_toolCallId, params: ForkToolParams, signal, onUpdate, ctx) {
      // ── Concurrency check ──────────────────────────────────────
      // Enforce concurrency per cwd, but base tmux layout only on forks
      // launched by this parent session so unrelated same-cwd Pi windows
      // do not get split accidentally.
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const runningForks = listRuns(10, ctx.cwd).filter((run) => run.state === "running");
      const layoutForks = parentSessionFile
        ? runningForks.filter((run) => run.parentSessionFile === parentSessionFile)
        : runningForks;
      const existingForkPaneIds = layoutForks
        .map((run) => run.tmuxPaneId)
        .filter((id): id is string => id !== undefined);

      const running = runningForks.length;
      if (running >= MAX_CONCURRENT_FORKS) {
        const result = emptyFailedResult(
          params.task,
          `Too many forks running for this working directory. Up to ${MAX_CONCURRENT_FORKS} concurrent forks allowed per cwd. Wait for one to finish before launching another.`,
        );
        return {
          content: [{ type: "text" as const, text: getResultSummaryText(result) }],
          details: makeDetails([result]),
          isError: true,
        };
      }

      const config = loadConfig(ctx.cwd);

      // Resolve model and thinking (tool arg > config > inherited fallback)
      const resolvedModel = params.model ?? config.defaultModel;
      const resolvedThinking = params.thinking ?? config.defaultThinking;

      // ── Session snapshot ───────────────────────────────────────
      const snapshot = buildForkSessionSnapshotJsonl(
        ctx.sessionManager,
        resolvedModel,
        resolvedThinking,
      );
      if (!snapshot) {
        const result = emptyFailedResult(
          params.task,
          "Cannot fork: failed to snapshot current session context.",
        );
        return {
          content: [{ type: "text" as const, text: getResultSummaryText(result) }],
          details: makeDetails([result]),
          isError: true,
        };
      }

      const isBackground = params.background === true;

      // ── Resolve fork cwd ───────────────────────────────────────
      const forkCwd = params.cwd?.trim()
        ? path.resolve(ctx.cwd, params.cwd.trim())
        : ctx.cwd;
      if (params.cwd?.trim() && !fs.existsSync(forkCwd)) {
        const result = emptyFailedResult(
          params.task,
          `Fork cwd '${params.cwd.trim()}' (resolved to '${forkCwd}') does not exist. Provide a valid directory path.`,
        );
        return {
          content: [{ type: "text" as const, text: getResultSummaryText(result) }],
          details: makeDetails([result]),
          isError: true,
        };
      }

      // ── Register run ───────────────────────────────────────────
      const runStatus = createRun(
        forkCwd,
        params.task,
        resolvedModel,
        resolvedThinking,
        parentSessionFile,
      );
      const runId = runStatus.runId;

      // ── Shared fork launch ─────────────────────────────────────
      // Build common options used by both wait and background modes
      const forkOptions = {
        cwd: forkCwd,
        task: params.task,
        forkSessionSnapshotJsonl: snapshot,
        model: resolvedModel,
        thinking: resolvedThinking,
        signal,
        runId,
        existingForkPaneIds,
        existingForkCount: layoutForks.length,
      };

      // ── Helper: handle fork completion ─────────────────────────
      const handleResult = (result: ForkResult): { content: { type: "text"; text: string }[]; details: ForkDetails; isError?: boolean } => {
        if (isResultError(result)) {
          failRun(runId, result.errorMessage || result.stopReason || "fork failed");
          return {
            content: [
              {
                type: "text" as const,
                text: `Fork ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
              },
            ],
            details: makeDetails([result]),
            isError: true,
          };
        }

        completeRun(runId, result.exitCode);
        return {
          content: [{ type: "text" as const, text: getResultSummaryText(result) }],
          details: makeDetails([result]),
        };
      };

      // ── Background mode ────────────────────────────────────────
      if (isBackground) {
        // Launch fork without awaiting — fire and forget
        runFork(forkOptions)
          .then((result) => {
            if (isResultError(result)) {
              failRun(runId, result.errorMessage || result.stopReason || "fork failed");
              pi.sendUserMessage(
                `[FORK_DONE] Fork run **${runId}** failed:\n${getResultSummaryText(result)}`,
                { deliverAs: "followUp" },
              );
              return;
            }

            completeRun(runId, result.exitCode);
            pi.sendUserMessage(
              `[FORK_DONE] Fork run **${runId}** completed.\n\n${getResultSummaryText(result)}`,
              { deliverAs: "followUp" },
            );
          })
          .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            failRun(runId, errorMessage);
            pi.sendUserMessage(
              `[FORK_DONE] Fork run **${runId}** crashed: ${errorMessage}`,
              { deliverAs: "followUp" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Fork launched in background as run **${runId}**. ` +
                `A new tmux pane has been created on the right for the fork session. ` +
                `Do not wait for this fork — you will receive a follow-up automatically when it finishes. ` +
                `Continue with other work or ask the user for the next task.`,
            },
          ],
          details: {},
        };
      }

      // ── Wait mode (default) ────────────────────────────────────
      try {
        const result = await runFork(forkOptions);
        return handleResult(result) as any;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failRun(runId, errorMessage);
        const result = emptyFailedResult(params.task, `Fork crashed: ${errorMessage}`);
        return {
          content: [{ type: "text" as const, text: getResultSummaryText(result) }],
          details: makeDetails([result]),
          isError: true,
        };
      }
    },
  });
}
