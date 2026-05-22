/**
 * Tmux helpers for pi-fork.
 * Adapted from archive/packages/subagents-lite/lib/tmux.ts
 *
 * Provides pane management for running interactive Pi sessions in tmux
 * sidecar panes on the right side of the terminal.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface TmuxPaneTarget {
  paneId: string;
  windowId?: string;
  sessionName?: string;
}

export function tmux(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const res = spawnSync("tmux", args, { encoding: "utf8" });
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
}

export function tmuxOrThrow(args: string[]): string {
  const result = tmux(args);
  if (result.ok) return result.stdout.trim();
  throw new Error(
    `tmux ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`,
  );
}

export function isTmuxAvailable(): boolean {
  return tmux(["-V"]).ok;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Read the parent PID of a Linux process from /proc/<pid>/stat.
 * Returns undefined if the process does not exist or /proc is unavailable.
 *
 * Exported for testing; prefer isAncestorPid() for consumption.
 */
export function getParentPid(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Format: pid (comm) state ppid ...
    // comm (field 1) is enclosed in parentheses and is the only field that
    // can contain whitespace, so we find its closing paren.
    const endParen = stat.lastIndexOf(")");
    if (endParen === -1) return undefined;
    // After the closing paren: space then state, space then ppid
    const rest = stat.slice(endParen + 2);
    const fields = rest.split(" ");
    return Number(fields[1]);
  } catch {
    return undefined;
  }
}

/**
 * Walk the process ancestry chain from `pid` up to determine whether
 * `ancestorPid` is an ancestor (or equals `pid` itself).
 *
 * Uses getParentPid() which reads /proc/<pid>/stat on Linux.
 * Returns true if ancestorPid is anywhere in the chain up to depth 100.
 */
export function isAncestorPid(ancestorPid: number, pid: number): boolean {
  let current = pid;
  for (let i = 0; i < 100; i++) {
    if (current === ancestorPid) return true;
    if (current <= 1) return false;
    const parent = getParentPid(current);
    // If we can't read the parent, stop (process may have exited)
    if (parent === undefined || parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Resolve the main Pi pane ID with TMUX_PANE verification.
 *
 * - Requires `TMUX_PANE` to be set (no unsafe fallback).
 * - Verifies the pane exists via tmux.
 * - Verifies the current process (`process.pid`) is a descendant of the
 *   pane's root process (`#{pane_pid}`) using /proc ancestry.
 * - Throws a descriptive error if any check fails.
 *
 * This prevents the fork extension from accidentally splitting a different
 * tmux pane/terminal when multiple Pi instances are running.
 */
export function resolveMainPaneId(): string {
  const tmuxPane = process.env.TMUX_PANE?.trim();
  if (!tmuxPane) {
    throw new Error(
      "Fork requires running inside a tmux pane with TMUX_PANE set.\n" +
      "The TMUX_PANE environment variable is not set or is empty.\n" +
      "Make sure Pi is running directly inside a tmux pane, or set " +
      "TMUX_PANE to the pane ID that contains this Pi session.",
    );
  }

  const panePid = getPanePid(tmuxPane);
  if (panePid === undefined) {
    throw new Error(
      `TMUX_PANE=${tmuxPane} — tmux pane does not exist or its PID is unavailable. ` +
      "Cannot determine the current tmux pane to split.",
    );
  }

  if (!isAncestorPid(panePid, process.pid)) {
    throw new Error(
      `TMUX_PANE=${tmuxPane} (pane PID ${panePid}) is not associated with the ` +
      `current Pi process (PID ${process.pid}).\n` +
      "The TMUX_PANE environment variable appears to point to a different terminal pane.\n" +
      "To fix this, run Pi directly inside a tmux pane (so tmux sets TMUX_PANE automatically), " +
      "or explicitly set TMUX_PANE to the pane ID that contains this Pi session.",
    );
  }

  return tmuxPane;
}

function parsePaneDescriptor(value: string): TmuxPaneTarget {
  const [paneIdRaw, windowIdRaw, sessionNameRaw] = value.split("|");
  const paneId = (paneIdRaw ?? "").trim();
  if (!paneId) {
    throw new Error(`tmux returned invalid pane descriptor: ${value}`);
  }
  return {
    paneId,
    windowId: (windowIdRaw ?? "").trim() || undefined,
    sessionName: (sessionNameRaw ?? "").trim() || undefined,
  };
}

/**
 * Create a fork pane in a 2x2 grid layout.
 *
 * Layout rules (all 50/50 even splits):
 *   0 existing running forks → split current/main pane vertically (left-right).
 *   1 existing running fork  → split that existing fork pane horizontally (top-bottom).
 *   2 existing running forks → split current/main pane horizontally (top-bottom).
 *
 * The main Pi always stays in the top-left corner.
 * If a referenced existing pane no longer exists, falls back to splitting current.
 */
export function createForkPane(
  existingForkPaneIds?: string[],
  existingForkCount?: number,
): TmuxPaneTarget {
  const format = "#{pane_id}|#{window_id}|#{session_name}";
  const mainPaneId = resolveMainPaneId();
  const current = parsePaneDescriptor(
    tmuxOrThrow(["display-message", "-p", "-t", mainPaneId, format]),
  );

  const count = existingForkCount ?? existingForkPaneIds?.length ?? 0;
  let targetPaneId: string;
  let splitDir: string;

  if (count === 0) {
    // First fork: split current pane vertically (left/right, 50/50)
    targetPaneId = current.paneId;
    splitDir = "-h";
  } else if (count === 1) {
    // Second fork: split the existing right-side fork pane horizontally
    const rightPaneId = existingForkPaneIds?.[0];
    if (rightPaneId && paneExists(rightPaneId)) {
      targetPaneId = rightPaneId;
    } else {
      targetPaneId = current.paneId;
    }
    splitDir = "-v";
  } else {
    // Third fork: split the main/current pane horizontally (top/bottom)
    targetPaneId = current.paneId;
    splitDir = "-v";
  }

  const forkPane = parsePaneDescriptor(
    tmuxOrThrow([
      "split-window",
      "-d",
      "-P",
      "-F",
      format,
      "-l",
      "50%",
      splitDir,
      "-t",
      targetPaneId,
      "bash",
    ]),
  );

  if (current.windowId) {
    tmux(["select-pane", "-t", current.paneId]);
  }

  return forkPane;
}

/**
 * Send Ctrl-C to a tmux pane.
 * Used to abort running forks.
 */
export function sendCtrlCToPane(paneId: string): boolean {
  return tmux(["send-keys", "-t", paneId, "C-c"]).ok;
}

/**
 * Kill a tmux pane by ID.
 */
export function killPane(paneId: string): boolean {
  return tmux(["kill-pane", "-t", paneId]).ok;
}

/**
 * Check whether a tmux pane still exists.
 */
export function paneExists(paneId: string): boolean {
  const out = tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
  return out.ok && out.stdout.trim() === paneId;
}

/**
 * Start piping a tmux pane's output to a log file.
 * Appends to the file; creates it if it does not exist.
 */
export function startPaneLogPipe(paneId: string, logPath: string): boolean {
  return tmux([
    "pipe-pane",
    "-o",
    "-t",
    paneId,
    `cat >> ${shellQuote(logPath)}`,
  ]).ok;
}

/**
 * Stop piping a tmux pane's output.
 */
export function stopPaneLogPipe(paneId: string): boolean {
  return tmux(["pipe-pane", "-t", paneId]).ok;
}

/**
 * Get the PID of the process running inside a tmux pane.
 */
export function getPanePid(paneId: string): number | undefined {
  const out = tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
  if (!out.ok) return undefined;
  const pid = Number(out.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}
