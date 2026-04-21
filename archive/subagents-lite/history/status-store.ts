/**
 * Persistent run history store for subagents-lite.
 *
 * Each run gets a directory under:
 *   ~/.pi/agent/extensions/subagents-lite/runs/<runId>/status.json
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunStatus, RunStatusStep, SubagentExecutionMode } from "../types.js";

// ─── Stale-run reaping ────────────────────────────────────────────────

/** Runs with no update for longer than this are considered dead. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check whether a tmux pane still exists.
 * Uses spawnSync directly (inlined to avoid circular dep on tmux helper).
 */
function tmuxPaneExists(paneId: string | undefined): boolean {
	if (!paneId) return false;
	try {
		const res = child_process.spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"], {
			encoding: "utf8",
			timeout: 3000,
		});
		return res.status === 0 && (res.stdout ?? "").trim() === paneId;
	} catch {
		return false;
	}
}

/**
 * Reap stale runs whose tmux panes are all dead (or that have had no
 * update for longer than STALE_THRESHOLD_MS and have no live panes).
 *
 * This is called lazily before listRuns/countRunningSubagents so that
 * orphaned runs from crashed parent sessions never block new launches.
 *
 * @returns number of runs reaped
 */
export function reapStaleRuns(): number {
	let entries: string[];
	try {
		entries = fs
			.readdirSync(RUNS_ROOT)
			.filter((e) =>
				fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
			);
	} catch {
		return 0;
	}

	let reaped = 0;
	const now = Date.now();

	for (const entry of entries) {
		const status = readJson(
			path.join(RUNS_ROOT, entry, "status.json"),
		) as RunStatus | null;
		if (!status || status.state !== "running") continue;

		// Check if any step still has a live tmux pane
		let hasLivePane = false;
		for (const step of status.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			if (step.tmuxPaneId && tmuxPaneExists(step.tmuxPaneId)) {
				hasLivePane = true;
				break;
			}
		}

		if (hasLivePane) continue;

		// No live panes — is the run stale by time?
		const ageSinceUpdate = now - (status.lastUpdate ?? status.startedAt);
		const isOld = ageSinceUpdate >= STALE_THRESHOLD_MS;

		// If we have pane IDs but they're all dead, reap immediately
		// regardless of time threshold (the panes are gone = the run is dead).
		const hasAnyPaneId = status.steps.some(
			(s) =>
				(s.status === "running" || s.status === "pending") &&
				s.tmuxPaneId,
		);

		if (!hasAnyPaneId && !isOld) continue;

		// Reap: mark as failed
		const now2 = Date.now();
		status.state = "failed";
		status.lastUpdate = now2;
		status.endedAt = now2;
		for (const step of status.steps) {
			if (step.status === "running" || step.status === "pending") {
				step.status = "error";
				step.error ??= "Run orphaned (parent session exited or tmux pane destroyed)";
				step.durationMs ??= Math.max(0, now2 - status.startedAt);
			}
		}
		writeJson(statusPath(entry), status);
		reaped++;
	}

	return reaped;
}

const RUNS_ROOT = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"subagents-lite",
	"runs",
);

function runDir(runId: string): string {
	return path.join(RUNS_ROOT, runId);
}

function statusPath(runId: string): string {
	return path.join(runDir(runId), "status.json");
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

// ─── Public API ─────────────────────────────────────────────────────────

export function createRun(
	runId: string,
	mode: "single" | "parallel",
	steps: RunStatusStep[],
	cwd?: string,
	executionMode: SubagentExecutionMode = "interactive",
	owner?: { sessionId?: string; sessionName?: string },
): RunStatus {
	const now = Date.now();
	const status: RunStatus = {
		runId,
		state: "running",
		mode,
		executionMode,
		ownerSessionId: owner?.sessionId,
		ownerSessionName: owner?.sessionName,
		startedAt: now,
		lastUpdate: now,
		cwd,
		steps,
	};
	writeJson(statusPath(runId), status);
	return status;
}

export function updateStep(
	runId: string,
	stepIndex: number,
	partial: Partial<RunStatusStep>,
): void {
	const status = readJson(statusPath(runId)) as RunStatus | null;
	if (!status || status.state !== "running") return;
	if (status.steps[stepIndex]) {
		Object.assign(status.steps[stepIndex], partial);
	}
	status.lastUpdate = Date.now();
	writeJson(statusPath(runId), status);
}

export function completeRun(runId: string): void {
	const status = readJson(statusPath(runId)) as RunStatus | null;
	if (!status || status.state !== "running") return;
	const now = Date.now();
	status.state = "complete";
	status.lastUpdate = now;
	status.endedAt = now;
	// Mark any pending/running steps as ok
	for (const step of status.steps) {
		if (step.status === "running" || step.status === "pending") {
			step.status = "ok";
		}
	}
	writeJson(statusPath(runId), status);
}

export function failRun(runId: string, error?: string): void {
	const status = readJson(statusPath(runId)) as RunStatus | null;
	if (!status || status.state !== "running") return;
	const now = Date.now();
	status.state = "failed";
	status.lastUpdate = now;
	status.endedAt = now;
	// Mark running steps as failed
	for (const step of status.steps) {
		if (step.status === "running") {
			step.status = "error";
			if (error) step.error = error;
		}
	}
	writeJson(statusPath(runId), status);
}

export function markRunDone(runId: string): void {
	const status = readJson(statusPath(runId)) as RunStatus | null;
	if (!status || status.state !== "running") return;
	const now = Date.now();
	status.state = "complete";
	status.lastUpdate = now;
	status.endedAt = now;
	for (const step of status.steps) {
		if (step.status === "running" || step.status === "pending") {
			step.status = "ok";
		}
	}
	writeJson(statusPath(runId), status);
}

export function recordStepReport(
	runId: string,
	stepIndex: number,
	report: string,
	options?: { markDone?: boolean },
): void {
	const status = readJson(statusPath(runId)) as RunStatus | null;
	if (!status || status.state !== "running") return;
	const step = status.steps[stepIndex];
	if (!step) return;

	const now = Date.now();
	step.report = report;
	step.reportUpdatedAt = now;
	if (options?.markDone && (step.status === "running" || step.status === "pending")) {
		step.status = "ok";
		step.durationMs ??= Math.max(0, now - status.startedAt);
	}

	const hasRunning = status.steps.some((s) => s.status === "running" || s.status === "pending");
	if (!hasRunning) {
		const hasError = status.steps.some((s) => s.status === "error");
		status.state = hasError ? "failed" : "complete";
		status.endedAt = now;
	}
	status.lastUpdate = now;
	writeJson(statusPath(runId), status);
}

export function getRunStatus(runId: string): RunStatus | null {
	return readJson(statusPath(runId)) as RunStatus | null;
}

export interface RunSummary {
	runId: string;
	state: RunStatus["state"];
	mode: RunStatus["mode"];
	executionMode?: RunStatus["executionMode"];
	ownerSessionId?: string;
	ownerSessionName?: string;
	startedAt: number;
	lastUpdate: number;
	endedAt?: number;
	cwd?: string;
	steps: RunStatusStep[];
}

/**
 * List recent runs sorted by state priority then time.
 * Reaps stale/orphaned runs first so they never appear as "running".
 */
export function listRuns(limit: number = 20): RunSummary[] {
	reapStaleRuns();
	let entries: string[];
	try {
		entries = fs
			.readdirSync(RUNS_ROOT)
			.filter((e) =>
				fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
			);
	} catch {
		return [];
	}

	const runs: RunSummary[] = [];
	for (const entry of entries) {
		const status = readJson(
			path.join(RUNS_ROOT, entry, "status.json"),
		) as RunStatus | null;
		if (!status) continue;
		runs.push({
			runId: status.runId,
			state: status.state,
			mode: status.mode,
			executionMode: status.executionMode,
			ownerSessionId: status.ownerSessionId,
			ownerSessionName: status.ownerSessionName,
			startedAt: status.startedAt,
			lastUpdate: status.lastUpdate,
			endedAt: status.endedAt,
			cwd: status.cwd,
			steps: status.steps,
		});
	}

	// Sort: running first, then by most recent
	const rank = (s: RunStatus["state"]): number => {
		switch (s) {
			case "running":
				return 0;
			case "failed":
				return 1;
			case "complete":
				return 2;
		}
	};
	runs.sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		return (
			(b.lastUpdate ?? b.endedAt ?? b.startedAt) -
			(a.lastUpdate ?? a.endedAt ?? a.startedAt)
		);
	});

	return runs.slice(0, limit);
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Max number of subagents that may be running simultaneously. */
export const MAX_CONCURRENT_SUBAGENTS = 3;

/** Count currently running subagent steps across all active runs. */
export function countRunningSubagents(): number {
	const runs = listRuns(100);
	let count = 0;
	for (const run of runs) {
		if (run.state !== "running") continue;
		for (const step of run.steps) {
			if (step.status === "running" || step.status === "pending") {
				count++;
			}
		}
	}
	return count;
}

export function getRunsRoot(): string {
	return RUNS_ROOT;
}

// ─── Run data cleanup ──────────────────────────────────────────────────

/** Keep this many completed/failed runs on disk (newer ones win). */
const PURGE_KEEP_COUNT = 20;

/** Runs younger than this are never purged. */
const PURGE_MIN_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Delete old completed/failed run directories to free disk space.
 * Keeps the most recent PURGE_KEEP_COUNT finished runs.
 * Never touches still-running runs (reapStaleRuns handles those).
 *
 * @returns number of runs purged
 */
export function purgeOldRuns(): number {
	let entries: string[];
	try {
		entries = fs
			.readdirSync(RUNS_ROOT)
			.filter((e) =>
				fs.statSync(path.join(RUNS_ROOT, e)).isDirectory(),
			);
	} catch {
		return 0;
	}

	const now = Date.now();

	// Collect finished runs with timestamps
	type Finished = { id: string; endedAt: number };
	const finished: Finished[] = [];

	for (const entry of entries) {
		const status = readJson(
			path.join(RUNS_ROOT, entry, "status.json"),
		) as RunStatus | null;
		if (!status) {
			// No status.json → orphan directory, always eligible
			finished.push({ id: entry, endedAt: 0 });
			continue;
		}
		if (status.state === "running") continue; // reapStaleRuns handles these
		const endedAt = status.endedAt ?? status.lastUpdate ?? status.startedAt;
		if (now - endedAt < PURGE_MIN_AGE_MS) continue; // too recent
		finished.push({ id: entry, endedAt });
	}

	// Sort newest first, keep top N, delete the rest
	finished.sort((a, b) => b.endedAt - a.endedAt);
	const toDelete = finished.slice(PURGE_KEEP_COUNT);

	for (const { id } of toDelete) {
		const dir = path.join(RUNS_ROOT, id);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort; may fail if files are locked
		}
	}

	return toDelete.length;
}
