/**
 * subagents-lite — lean subagent extension for pi-coding-agent.
 *
 * Features:
 * - Predefined agents (scout, researcher, etc.) loaded from .md files
 * - Parallel launch of up to 4 subagents
 * - Run history + status overlay (/subagents-status)
 * - LLM-callable tool: launch_subagents
 */

import * as os from "node:os";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents, discoverAgentsWithMetadata } from "./agent-registry.js";
import type { AgentSource } from "./types.js";
import { registerCommands } from "./commands.js";
import {
	createRun,
	getRunStatus,
	recordStepReport,
	updateStep,
	completeRun,
	failRun,
} from "./history/status-store.js";
import {
	decodeSubagentIntercomEvent,
	encodeSubagentIntercomEvent,
} from "./lib/intercom-protocol.js";
import { MAX_SUBAGENTS_PER_RUN } from "./types.js";

const LaunchSubagentsParams = Type.Object({
	agents: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Agent names to launch (duplicates allowed, e.g. ['scout','scout','researcher']). Max 4 total.",
	}),
	task: Type.String({
		description: "The task description for all agents.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (default: current cwd)" }),
	),
	parallel: Type.Optional(
		Type.Boolean({
			description: "Run agents in parallel (default: true)",
		}),
	),
	maxConcurrency: Type.Optional(
		Type.Number({
			description: "Max concurrent agents, clamped 1-4 (default: 4)",
		}),
	),
	modelOverride: Type.Optional(
		Type.String({
			description:
				"Override model for all agents (e.g. 'anthropic/claude-sonnet-4')",
		}),
	),
});

interface LaunchParams {
	agents: string[];
	task: string;
	cwd?: string;
	parallel?: boolean;
	maxConcurrency?: number;
	modelOverride?: string;
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { content?: unknown; role?: string };
	if (candidate.role !== "assistant") return "";

	const content = candidate.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: string; text?: string; content?: string };
		if (typed.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
			continue;
		}
		if (typeof typed.content === "string") {
			parts.push(typed.content);
		}
	}
	return parts.join("\n").trim();
}

function compactReport(text: string, maxLen: number = 1800): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (trimmed.length <= maxLen) return trimmed;
	return `${trimmed.slice(0, maxLen - 3)}...`;
}

const INTERCOM_READY_EVENT = "pi-intercom:ready";
const INTERCOM_INCOMING_EVENT = "pi-intercom:incoming";
const INTERCOM_SEND_REQUEST_EVENT = "pi-intercom:send-request";
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";

function defaultIntercomAlias(sessionId: string): string {
	const normalized = sessionId.startsWith("session-")
		? sessionId.slice("session-".length)
		: sessionId;
	return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalized.slice(0, 8)}`;
}

function extractIntercomMessageText(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const raw = payload as { message?: { content?: { text?: unknown } } };
	const text = raw.message?.content?.text;
	return typeof text === "string" ? text : null;
}

const HOME_DIR = os.homedir();

function shortenHomePath(filePath: string): string {
	if (!filePath) return filePath;
	if (filePath === HOME_DIR) return "~";
	if (filePath.startsWith(`${HOME_DIR}/`)) {
		return `~/${filePath.slice(HOME_DIR.length + 1)}`;
	}
	if (filePath.startsWith(`${HOME_DIR}\\`)) {
		return `~\\${filePath.slice(HOME_DIR.length + 1)}`;
	}
	return filePath;
}

function formatAgentSourceLabel(source: AgentSource): string {
	switch (source) {
		case "builtin": return "builtin";
		case "user": return "user";
		case "project": return "project";
	}
}

function buildAgentDiscoverySummary(cwd: string): {
	lines: string[];
	hasConflicts: boolean;
} {
	const discovery = discoverAgentsWithMetadata(cwd);
	const count = discovery.agents.length;
	const lines: string[] = [
		`Subagents: loaded ${count} agent${count === 1 ? "" : "s"}.`,
	];

	// Build scope groups: map source -> paths (mirrors pi's buildScopeGroups)
	const sourceDirMap = new Map<string, string[]>();
	if (discovery.loadedFrom.builtin) {
		sourceDirMap.set("builtin", [shortenHomePath(discovery.loadedFrom.builtin)]);
	}
	for (const userDir of discovery.loadedFrom.user) {
		const existing = sourceDirMap.get("user") ?? [];
		existing.push(shortenHomePath(userDir));
		sourceDirMap.set("user", existing);
	}
	if (discovery.loadedFrom.project) {
		sourceDirMap.set("project", [shortenHomePath(discovery.loadedFrom.project)]);
	}

	if (sourceDirMap.size > 0) {
		lines.push("Loaded from:");
		for (const [source, paths] of sourceDirMap) {
			for (const p of paths) {
				lines.push(`  ${source} ${p}`);
			}
		}
	} else {
		lines.push("Loaded from: none");
	}

	if (discovery.conflicts.length === 0) {
		return { lines, hasConflicts: false };
	}

	lines.push("[Agent conflicts]");
	for (const conflict of discovery.conflicts) {
		const winnerLabel = formatAgentSourceLabel(conflict.winner.source);
		lines.push(`  "${conflict.name}" collision:`);
		lines.push(`    ✓ ${winnerLabel} ${shortenHomePath(conflict.winner.filePath)}`);
		for (const entry of conflict.overridden) {
			const loserLabel = formatAgentSourceLabel(entry.source);
			lines.push(`    ✗ ${loserLabel} ${shortenHomePath(entry.filePath)} (skipped)`);
		}
	}

	return { lines, hasConflicts: true };
}

function registerChildLifecycleBridge(pi: ExtensionAPI): void {
	const runId = process.env.PI_SUBAGENT_RUN_ID?.trim();
	const stepIndex = Number.parseInt(process.env.PI_SUBAGENT_STEP_INDEX ?? "", 10);
	const label = process.env.PI_SUBAGENT_LABEL?.trim() || `step-${stepIndex}`;
	const target = process.env.PI_SUBAGENT_PARENT_INTERCOM_TARGET?.trim();
	if (!runId || !Number.isFinite(stepIndex) || stepIndex < 0 || !target) return;

	let finalEventSent = false;

	const sendEvent = (event: Parameters<typeof encodeSubagentIntercomEvent>[0]): void => {
		pi.events.emit(INTERCOM_SEND_REQUEST_EVENT, {
			to: target,
			message: encodeSubagentIntercomEvent(event),
		});
	};

	pi.on("turn_end", (event) => {
		if (finalEventSent) return;
		const report = compactReport(extractMessageText(event.message));
		if (!report) return;
		sendEvent({
			source: "subagents-lite",
			version: 1,
			kind: "report",
			runId,
			stepIndex,
			label,
			report,
			timestamp: Date.now(),
		});
		finalEventSent = true;
	});

	pi.on("session_shutdown", () => {
		if (finalEventSent) return;
		sendEvent({
			source: "subagents-lite",
			version: 1,
			kind: "error",
			runId,
			stepIndex,
			label,
			error: "Subagent session ended before sending a final report.",
			timestamp: Date.now(),
		});
		finalEventSent = true;
	});
}

export default function subagentsLiteExtension(pi: ExtensionAPI): void {
	registerChildLifecycleBridge(pi);

	let localSessionId: string | undefined;
	let localIntercomSessionId: string | undefined;
	const syncLocalSessionId = (id: string): void => {
		localSessionId = id;
	};

	pi.on("session_start", (_event, ctx) => {
		syncLocalSessionId(ctx.sessionManager.getSessionId());
		if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD === "1") return;
		try {
			const summary = buildAgentDiscoverySummary(ctx.cwd);
			ctx.ui.notify(summary.lines.join("\n"), summary.hasConflicts ? "warning" : "info");
		} catch {
			// Best-effort startup summary only.
		}
	});
	pi.on("turn_start", (_event, ctx) => {
		syncLocalSessionId(ctx.sessionManager.getSessionId());
	});

	pi.events.on(INTERCOM_READY_EVENT, (payload) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as { sessionId?: unknown };
		if (typeof event.sessionId === "string" && event.sessionId) {
			localIntercomSessionId = event.sessionId;
		}
	});

	pi.events.on(INTERCOM_INCOMING_EVENT, (payload) => {
		const text = extractIntercomMessageText(payload);
		if (!text) return;
		const bridgeEvent = decodeSubagentIntercomEvent(text);
		if (!bridgeEvent) return;

		const run = getRunStatus(bridgeEvent.runId);
		if (!run) return;
		if (run.ownerSessionId && localSessionId && run.ownerSessionId !== localSessionId) {
			return;
		}

		if (bridgeEvent.kind === "report") {
			if (bridgeEvent.report) {
				recordStepReport(bridgeEvent.runId, bridgeEvent.stepIndex, bridgeEvent.report, {
					markDone: true,
				});
			}
			return;
		}

		if (bridgeEvent.kind === "error") {
			updateStep(bridgeEvent.runId, bridgeEvent.stepIndex, {
				status: "error",
				error: bridgeEvent.error ?? "Subagent exited before producing a final report.",
				report: bridgeEvent.report,
				reportUpdatedAt: bridgeEvent.report ? bridgeEvent.timestamp : undefined,
			});
		}
	});

	registerCommands(pi);

	pi.registerTool({
		name: "launch_subagents",
		label: "Launch Subagents",
		description: `Launch one or more subagents to work on a task in parallel. Subagents run in interactive tmux panes for live visibility and control. Max ${MAX_SUBAGENTS_PER_RUN} agents per call; duplicates allowed (e.g. 3 scouts). Use when the user says "use scout", "ask researcher", "launch scout and researcher", or "run a few scouts".`,
		parameters: LaunchSubagentsParams as any,
		async execute(
			_toolCallId: string,
			params: LaunchParams,
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const { agents: agentNames, task, modelOverride } = params;
			const cwd = params.cwd ?? ctx.cwd;

			if (agentNames.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No agents specified. Provide at least one agent name.",
						},
					],
					details: {},
				};
			}
			if (agentNames.length > MAX_SUBAGENTS_PER_RUN) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Too many agents (${agentNames.length}). Maximum is ${MAX_SUBAGENTS_PER_RUN} per call.`,
						},
					],
					details: {},
				};
			}

			const agents = discoverAgents(cwd);
			const unknown = agentNames.filter(
				(name) => !agents.find((a) => a.name === name),
			);
			if (unknown.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Unknown agent(s): ${unknown.join(", ")}. Available: ${agents.map((a) => a.name).join(", ")}`,
						},
					],
					details: {},
				};
			}

			const { randomUUID } = await import("node:crypto");
			const { runSingleAgent } = await import("./runner.js");
			const { runParallelAgents } = await import("./lib/parallel.js");

			const runId = randomUUID().slice(0, 8);
			const mode = agentNames.length === 1 ? "single" : "parallel";

			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentSessionName = pi.getSessionName();
			const parentIntercomTarget =
				localIntercomSessionId ??
				(parentSessionName?.trim() || defaultIntercomAlias(parentSessionId));

			const labelCounts = new Map<string, number>();
			const requests = agentNames.map((name, index) => {
				const agent = agents.find((a) => a.name === name)!;
				const count = (labelCounts.get(name) ?? 0) + 1;
				labelCounts.set(name, count);
				const label = count === 1 ? name : `${name}#${count}`;
				return {
					agent,
					task,
					runId,
					cwd,
					modelOverride,
					index,
					label,
					parentSessionId,
					parentSessionName,
					parentIntercomTarget,
					runtime: "tmux" as const,
					executionMode: "interactive" as const,
				};
			});

			createRun(
				runId,
				mode,
				requests.map((r) => ({
					agent: r.agent.name,
					label: r.label,
					status: "pending" as const,
					runtime: "tmux" as const,
					executionMode: "interactive" as const,
					taskPreview: task.length > 140 ? `${task.slice(0, 137)}...` : task,
					configuredSkills: r.agent.skills,
				})),
				cwd,
				"interactive",
				{ sessionId: parentSessionId, sessionName: parentSessionName },
			);

			const formatResults = (
				results: import("./types.js").SubagentRunResult[],
			): string => {
				const lines: string[] = [];
				for (const r of results) {
					const icon = r.status === "ok" ? "✅" : "❌";
					lines.push(
						`${icon} **${r.label}** (${(r.durationMs / 1000).toFixed(1)}s | interactive tmux)`,
					);
					if (r.tmuxPaneId) {
						lines.push(
							`   Pane: ${r.tmuxPaneId}${r.tmuxSessionName ? ` (${r.tmuxSessionName})` : ""}`,
						);
					}
					if (r.report) {
						lines.push(`   Report: ${r.report.replace(/\s+/g, " ").trim().slice(0, 220)}`);
					}
					if (r.error) lines.push(`   Error: ${r.error}`);
				}
				return lines.join("\n");
			};

			const runExecution = async (): Promise<import("./types.js").SubagentRunResult[]> => {
				let results: import("./types.js").SubagentRunResult[];

				if (requests.length === 1) {
					updateStep(runId, 0, { status: "running" });
					const result = await runSingleAgent(requests[0]!);
					updateStep(runId, 0, {
						status: result.status === "ok" ? "ok" : "error",
						durationMs: result.durationMs,
						error: result.error,
						report: result.report,
						reportUpdatedAt: result.report ? Date.now() : undefined,
					});
					results = [result];
				} else {
					for (let i = 0; i < requests.length; i++) {
						updateStep(runId, i, { status: "running" });
					}
					results = await runParallelAgents(requests);
					for (let i = 0; i < results.length; i++) {
						const r = results[i]!;
						updateStep(runId, i, {
							status: r.status === "ok" ? "ok" : "error",
							durationMs: r.durationMs,
							error: r.error,
							report: r.report,
							reportUpdatedAt: r.report ? Date.now() : undefined,
						});
					}
				}

				const allOk = results.every((r) => r.status === "ok");
				if (allOk) completeRun(runId);
				else failRun(runId);
				return results;
			};

			void (async () => {
				try {
					const results = await runExecution();
					pi.sendMessage({
						customType: "text",
						content: formatResults(results),
						display: true,
					});
				} catch (error) {
					failRun(
						runId,
						error instanceof Error ? error.message : String(error),
					);
					pi.sendMessage({
						customType: "text",
						content: `Error: ${error instanceof Error ? error.message : String(error)}`,
						display: true,
					});
				}
			})();

			const labels = requests.map((r) => r.label).join(", ");
			return {
				content: [
					{
						type: "text",
						text:
							`🚀 Started interactive subagents in tmux (${labels})\n` +
							`Run: ${runId}\n` +
							"Started initial task in each pane. Pane auto-closes after a final report is captured. Use /subagents-status to monitor and control.",
					},
				],
				details: {},
			};
		},
	});
}
