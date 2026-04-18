/**
 * subagents-lite — lean subagent extension for pi-coding-agent.
 *
 * Features:
 * - Predefined agents (scout, researcher, etc.) loaded from .md files
 * - Single-agent launch per tool call (orchestrator can issue multiple calls in parallel)
 * - Run history persisted for runtime coordination
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
import { buildSubagentReportMessage } from "./reporting.js";
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
import { registerSubagentReportMessageRenderer } from "./tui/subagent-report-message.js";

const LaunchSubagentsParams = Type.Object({
	agents: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 1,
		description:
			"Exactly one agent name to launch per call (e.g. ['scout']). To run multiple agents, issue multiple tool calls (they may run in parallel).",
	}),
	task: Type.String({
		description: "The task description for the agent.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (default: current cwd)" }),
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

function compactReport(text: string): string {
	return text.trim();
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

	// Track the latest assistant message text across turns so we can send
	// it as the report once the full agentic loop completes.
	// NOTE: We intentionally do NOT send on "turn_end" because that event
	// fires per model API call (each turn in the agent loop), not after the
	// full agentic loop completes. Sending on turn_end caused subagents to
	// be killed mid-task when the model produced text alongside tool calls.
	let lastReport = "";

	pi.on("turn_end", (event) => {
		const text = compactReport(extractMessageText(event.message));
		if (text) lastReport = text;
	});

	pi.on("agent_end", (event) => {
		if (finalEventSent) return;
		// Extract the last assistant message from the full conversation.
		// This is more reliable than turn_end because agent_end fires only
		// after the complete agentic loop finishes.
		let report = lastReport;
		if (!report && Array.isArray(event.messages)) {
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const text = extractMessageText(event.messages[i]);
				if (text) {
					report = text;
					break;
				}
			}
		}
		if (report) {
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
		} else {
			sendEvent({
				source: "subagents-lite",
				version: 1,
				kind: "error",
				runId,
				stepIndex,
				label,
				error: "Subagent completed but produced no report text.",
				timestamp: Date.now(),
			});
		}
		finalEventSent = true;
	});

	pi.on("session_shutdown", () => {
		if (finalEventSent) return;
		// Session is shutting down without completing the agentic loop.
		// Send whatever report we have, or an error.
		if (lastReport) {
			sendEvent({
				source: "subagents-lite",
				version: 1,
				kind: "report",
				runId,
				stepIndex,
				label,
				report: lastReport,
				timestamp: Date.now(),
			});
		} else {
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
		}
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

	registerSubagentReportMessageRenderer(pi);
	registerCommands(pi);

	pi.registerTool({
		name: "launch_subagents",
		label: "Launch Subagent",
		description: "Launch exactly one subagent for a task in an interactive tmux pane. For multiple agents, call this tool multiple times (those calls may run in parallel). Max 3 concurrent subagents globally. Use when the user says \"use scout\" or \"ask researcher\".",
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
			if (agentNames.length > 1) {
				return {
					content: [
						{
							type: "text",
							text: `Error: launch_subagents accepts exactly 1 agent per call (received ${agentNames.length}). Call the tool multiple times to run multiple agents in parallel.`,
						},
					],
					details: {},
				};
			}

			// Enforce global concurrent cap
			const { countRunningSubagents, MAX_CONCURRENT_SUBAGENTS } = await import("./history/status-store.js");
			const runningCount = countRunningSubagents();
			if (runningCount >= MAX_CONCURRENT_SUBAGENTS) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Cannot launch — ${runningCount} subagent${runningCount === 1 ? "" : "s"} already running (max ${MAX_CONCURRENT_SUBAGENTS}). Wait for one to finish or manage them in tmux.`,
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

			const runId = randomUUID().slice(0, 8);
			const mode = "single";

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

			const runExecution = async (): Promise<import("./types.js").SubagentRunResult[]> => {
				updateStep(runId, 0, { status: "running" });
				const result = await runSingleAgent(requests[0]!);
				updateStep(runId, 0, {
					status: result.status === "ok" ? "ok" : "error",
					durationMs: result.durationMs,
					error: result.error,
					report: result.report,
					reportUpdatedAt: result.report ? Date.now() : undefined,
				});

				if (result.status === "ok") completeRun(runId);
				else failRun(runId, result.error);
				return [result];
			};

			void (async () => {
				try {
					const results = await runExecution();
					pi.sendMessage(buildSubagentReportMessage(results));
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
							`🚀 Started interactive subagent in tmux (${labels})\n` +
							`Run: ${runId}\n` +
							"Started initial task in the pane. Pane auto-closes after a final report is captured. Manage live runs directly from tmux panes.",
					},
				],
				details: {},
			};
		},
	});
}
