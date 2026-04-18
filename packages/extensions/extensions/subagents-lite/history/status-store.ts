/**
 * Persistent run history store for subagents-lite.
 *
 * Each run gets a directory under:
 *   ~/.pi/agent/extensions/subagents-lite/runs/<runId>/status.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunStatus, RunStatusStep, SubagentExecutionMode } from "../types.js";

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
 */
export function listRuns(limit: number = 20): RunSummary[] {
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
