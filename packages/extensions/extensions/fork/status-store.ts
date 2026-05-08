/**
 * Persistent run status store for pi-fork.
 *
 * Each fork run gets a directory under:
 *   ~/.pi/agent/extensions/fork/runs/<runId>/status.json
 *
 * Responsibilities:
 * - Create/update/complete/fail runs
 * - Enforce MAX_CONCURRENT_FORKS = 2 global cap
 * - Reap stale/orphaned runs on a time-based threshold
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────

export interface ForkRunStatus {
  runId: string;
  state: "running" | "complete" | "failed";
  startedAt: number;
  lastUpdate: number;
  endedAt?: number;
  cwd?: string;
  task?: string;
  model?: string;
  thinking?: string;
  tmuxPaneId?: string;
  tmuxWindowId?: string;
  tmuxSessionName?: string;
  sessionFile?: string;
  logPath?: string;
  resultPath?: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

export type ForkRunState = ForkRunStatus["state"];

// ─── Constants ─────────────────────────────────────────────────────────

export const MAX_CONCURRENT_FORKS = 1;

/** Runs with no update for longer than this are considered orphaned. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Root directory for fork run data.
 * ~/.pi/agent/extensions/fork/runs/
 */
const RUNS_ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "fork", "runs");

// ─── Helpers ───────────────────────────────────────────────────────────

function runDir(runId: string): string {
  return path.join(RUNS_ROOT, runId);
}

function statusPath(runId: string): string {
  return path.join(runDir(runId), "status.json");
}

export function getRunArtifactPath(runId: string, fileName: string): string {
  return path.join(runDir(runId), fileName);
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function generateRunId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ─── Stale-run reaping ─────────────────────────────────────────────────

/**
 * Reap stale runs that have had no update for longer than STALE_THRESHOLD_MS.
 *
 * This is called lazily before countRunningForks() so that orphaned runs
 * from crashed parent sessions never block new launches.
 *
 * @returns number of runs reaped
 */
export function reapStaleRuns(): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_ROOT).filter((e) =>
      fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
    );
  } catch {
    return 0;
  }

  let reaped = 0;
  const now = Date.now();

  for (const entry of entries) {
    const status = readJson(statusPath(entry)) as ForkRunStatus | null;
    if (!status || status.state !== "running") continue;

    const ageSinceUpdate = now - status.lastUpdate;
    if (ageSinceUpdate < STALE_THRESHOLD_MS) continue;

    // Reap: mark as failed
    status.state = "failed";
    status.lastUpdate = now;
    status.endedAt = now;
    status.error = "Run orphaned (no update for 30+ minutes)";
    writeJson(statusPath(entry), status);
    reaped++;
  }

  return reaped;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Create a new fork run.
 * @returns The newly created run status.
 */
export function createRun(
  cwd?: string,
  task?: string,
  model?: string,
  thinking?: string,
): ForkRunStatus {
  const runId = generateRunId();
  const now = Date.now();
  const status: ForkRunStatus = {
    runId,
    state: "running",
    startedAt: now,
    lastUpdate: now,
    cwd,
    task,
    model,
    thinking,
  };
  writeJson(statusPath(runId), status);
  return status;
}

/**
 * Update a running fork run with partial fields.
 * Does nothing if the run does not exist or is not in "running" state.
 */
export function updateRun(runId: string, partial: Partial<ForkRunStatus>): void {
  const status = readJson(statusPath(runId)) as ForkRunStatus | null;
  if (!status || status.state !== "running") return;
  Object.assign(status, partial);
  status.lastUpdate = Date.now();
  writeJson(statusPath(runId), status);
}

/**
 * Mark a fork run as complete.
 */
export function completeRun(runId: string, exitCode?: number): void {
  const status = readJson(statusPath(runId)) as ForkRunStatus | null;
  if (!status || status.state !== "running") return;
  const now = Date.now();
  status.state = "complete";
  status.lastUpdate = now;
  status.endedAt = now;
  if (exitCode !== undefined) status.exitCode = exitCode;
  writeJson(statusPath(runId), status);
}

/**
 * Mark a fork run as failed.
 */
export function failRun(runId: string, error?: string): void {
  const status = readJson(statusPath(runId)) as ForkRunStatus | null;
  if (!status || status.state !== "running") return;
  const now = Date.now();
  status.state = "failed";
  status.lastUpdate = now;
  status.endedAt = now;
  if (error) status.error = error;
  writeJson(statusPath(runId), status);
}

/**
 * Get the current status of a fork run.
 */
export function getRunStatus(runId: string): ForkRunStatus | null {
  return readJson(statusPath(runId)) as ForkRunStatus | null;
}

/**
 * Count currently running fork processes across all runs.
 * Reaps stale runs first so orphaned entries never block new launches.
 */
export function countRunningForks(): number {
  reapStaleRuns();

  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_ROOT).filter((e) =>
      fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
    );
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const status = readJson(statusPath(entry)) as ForkRunStatus | null;
    if (status && status.state === "running") {
      count++;
    }
  }

  return count;
}

/**
 * List recent fork runs sorted by most recent lastUpdate first.
 */
export function listRuns(limit: number = 20): ForkRunStatus[] {
  reapStaleRuns();

  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_ROOT).filter((e) =>
      fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
    );
  } catch {
    return [];
  }

  const runs: ForkRunStatus[] = [];
  for (const entry of entries) {
    const status = readJson(statusPath(entry)) as ForkRunStatus | null;
    if (status) runs.push(status);
  }

  const rank = (s: ForkRunState): number => {
    switch (s) {
      case "running": return 0;
      case "failed": return 1;
      case "complete": return 2;
    }
  };

  runs.sort((a, b) => {
    const byState = rank(a.state) - rank(b.state);
    if (byState !== 0) return byState;
    return b.lastUpdate - a.lastUpdate;
  });

  return runs.slice(0, limit);
}
