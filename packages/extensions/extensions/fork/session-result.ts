/**
 * Session file result parser for pi-fork.
 *
 * Parses a child Pi's session.jsonl file into a ForkResult after the child
 * has auto-exited. This replaces the old JSON-event-streaming result path.
 */

import { readFileSync } from "node:fs";
import { type ForkResult, emptyUsage } from "./types.js";

export interface ParsedSessionResult {
  finalOutput: string;
  model?: string;
  provider?: string;
  stopReason?: string;
  usage: ReturnType<typeof emptyUsage>;
  turnCount: number;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part: unknown): part is { type: string; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Parse a session JSONL file and extract the final assistant output,
 * usage stats, and model metadata.
 *
 * The session file is written incrementally by Pi's session manager.
 * Line 0 is the session header (metadata). Subsequent lines are JSON
 * message entries with role, content, usage, etc.
 *
 * Returns null if the file cannot be read or has no parseable entries.
 */
export function parseSessionResult(sessionFile: string): ParsedSessionResult | null {
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return null;
  }

  const lines = content.trim().split("\n");
  if (lines.length < 2) return null;

  // Line 0 is the session header; parse entries from line 1 onward
  const entries: unknown[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length === 0) return null;

  let finalOutput = "";
  let model: string | undefined;
  let provider: string | undefined;
  let stopReason: string | undefined;
  const usage = emptyUsage();
  let turnCount = 0;

  for (const entry of entries) {
    // Session JSONL stores entries as wrappers like:
    // { type: "message", message: { role, content, usage, ... } }
    // but older/other flows may still present raw message-shaped objects.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = entry as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = raw?.type === "message" && raw?.message ? raw.message as any : raw;
    if (!e || e.role !== "assistant") continue;

    const text = extractTextFromContent(e.content);
    if (text) finalOutput = text;

    if (typeof e.model === "string") model = e.model;
    if (typeof e.provider === "string") provider = e.provider;
    if (typeof e.stopReason === "string") stopReason = e.stopReason;
    turnCount++;

    const entryUsage = e.usage;
    if (entryUsage) {
      usage.input += typeof entryUsage.input === "number" ? entryUsage.input : 0;
      usage.output += typeof entryUsage.output === "number" ? entryUsage.output : 0;
      usage.cacheRead += typeof entryUsage.cacheRead === "number" ? entryUsage.cacheRead : 0;
      usage.cacheWrite += typeof entryUsage.cacheWrite === "number" ? entryUsage.cacheWrite : 0;

      const costVal = entryUsage.cost;
      usage.cost +=
        typeof costVal === "object" && costVal !== null
          ? typeof costVal.total === "number"
            ? costVal.total
            : 0
          : typeof costVal === "number"
            ? costVal
            : 0;

      usage.turns++;
      usage.contextTokens = Math.max(
        usage.contextTokens,
        typeof entryUsage.totalTokens === "number" ? entryUsage.totalTokens : 0,
        typeof entryUsage.contextTokens === "number" ? entryUsage.contextTokens : 0,
      );
    }
  }

  return { finalOutput, model, provider, stopReason, usage, turnCount };
}

/**
 * Build a ForkResult from a parsed session result.
 */
export function makeForkResult(
  task: string,
  parsed: ParsedSessionResult,
  exitCode: number,
): ForkResult {
  const messages = parsed.finalOutput.trim()
    ? [
        {
          role: "assistant",
          content: [{ type: "text", text: parsed.finalOutput }],
          provider: parsed.provider,
          model: parsed.model,
          stopReason: parsed.stopReason,
          usage: parsed.usage,
        } as any,
      ]
    : [];

  return {
    task,
    exitCode,
    messages,
    stderr: "",
    usage: parsed.usage,
    provider: parsed.provider,
    model: parsed.model,
    stopReason: parsed.stopReason,
  };
}
