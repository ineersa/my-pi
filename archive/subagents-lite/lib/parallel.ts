/**
 * Parallel execution with hard cap of MAX_SUBAGENTS_PER_RUN.
 * NOTE: This module is retained for internal/test use only.
 * The launch_subagents tool and /run-agent command both enforce 1 agent per call.
 */

import type { SubagentRunRequest, SubagentRunResult } from "../types.js";
import { MAX_SUBAGENTS_PER_RUN } from "../types.js";
import { runSingleAgent } from "../runner.js";
import { createSidecarPaneStack } from "./tmux.js";

/**
 * Validate and expand a list of agent names into SubagentRunRequests.
 * Returns an error string if validation fails, otherwise the requests.
 */
export function expandLaunchRequests(
	agentNames: string[],
	task: string,
	cwd: string,
	modelOverride?: string,
): { requests: SubagentRunRequest[] } | { error: string } {
	if (agentNames.length === 0) {
		return { error: "No agents specified." };
	}
	if (agentNames.length > MAX_SUBAGENTS_PER_RUN) {
		return {
			error: `Too many agent launches (${agentNames.length}). Maximum is ${MAX_SUBAGENTS_PER_RUN}.`,
		};
	}

	// De-duplicate agent name imports is handled at discovery level;
	// we allow duplicate names here (e.g. 3 scouts).
	// Just validate all names exist at call site.

	// Label duplicates: scout, scout#2, scout#3
	const labelCounts = new Map<string, number>();
	const requests: SubagentRunRequest[] = agentNames.map((name, index) => {
		const count = (labelCounts.get(name) ?? 0) + 1;
		labelCounts.set(name, count);
		const label = count === 1 ? name : `${name}#${count}`;
		return {
			agent: null as never, // filled by caller after resolving names
			task,
			cwd,
			modelOverride,
			index,
			label,
		};
	});

	return { requests };
}

async function prepareTmuxGridIfNeeded(requests: SubagentRunRequest[]): Promise<void> {
	if (requests.length <= 1) return;

	const runId = requests[0]?.runId;
	const panes = createSidecarPaneStack(requests.length);

	let updateStep: ((runId: string, stepIndex: number, partial: Record<string, unknown>) => void) | undefined;
	if (runId) {
		const store = await import("../history/status-store.js");
		updateStep = store.updateStep as typeof updateStep;
	}

	for (let i = 0; i < requests.length; i++) {
		const request = requests[i]!;
		const pane = panes[i]!;
		request.tmuxTarget = {
			paneId: pane.paneId,
			windowId: pane.windowId,
			sessionName: pane.sessionName,
		};
		if (runId && updateStep) {
			updateStep(runId, request.index, {
				runtime: "tmux",
				executionMode: "interactive",
				tmuxPaneId: pane.paneId,
				tmuxWindowId: pane.windowId,
				tmuxSessionName: pane.sessionName,
			});
		}
	}
}

const PARALLEL_LAUNCH_STAGGER_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run multiple subagents concurrently (bounded concurrency).
 * Individual failures do NOT cancel other runs.
 *
 * Starts are intentionally staggered by 2s to avoid provider startup collisions.
 */
export async function runParallelAgents(
	requests: SubagentRunRequest[],
	concurrency: number = MAX_SUBAGENTS_PER_RUN,
): Promise<SubagentRunResult[]> {
	const safeLimit = Math.max(
		1,
		Math.min(Math.floor(concurrency) || 1, MAX_SUBAGENTS_PER_RUN),
	);
	const results: SubagentRunResult[] = new Array(requests.length);
	let next = 0;
	const launchEpoch = Date.now();

	await prepareTmuxGridIfNeeded(requests);

	async function worker(): Promise<void> {
		while (next < requests.length) {
			const i = next++;
			if (i > 0) {
				const targetStart = launchEpoch + i * PARALLEL_LAUNCH_STAGGER_MS;
				const delay = targetStart - Date.now();
				if (delay > 0) await sleep(delay);
			}
			results[i] = await runSingleAgent(requests[i]!);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(safeLimit, requests.length) }, () =>
			worker(),
		),
	);

	return results;
}
