/**
 * Slash commands: /run-agent, /subagents-status
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { discoverAgents } from "./agent-registry.js";
import { buildSubagentReportMessage } from "./reporting.js";
import { SubagentsStatusComponent } from "./tui/subagents-status.js";

const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";

function defaultIntercomAlias(sessionId: string): string {
	const normalized = sessionId.startsWith("session-")
		? sessionId.slice("session-".length)
		: sessionId;
	return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalized.slice(0, 8)}`;
}

/**
 * Parse `/run-agent <name> -- <task>`.
 */
function parseCommandArgs(
	args: string,
): { names: string[]; task: string } | null {
	const input = args.trim();
	const delimiterIndex = input.indexOf(" -- ");
	if (delimiterIndex === -1) return null;

	let namesPart = input.slice(0, delimiterIndex).trim();
	const task = input.slice(delimiterIndex + 4).trim();
	if (!namesPart || !task) return null;

	if (namesPart.startsWith("--tmux ")) {
		namesPart = namesPart.slice("--tmux".length).trim();
	}
	if (
		namesPart.startsWith("--json ") ||
		namesPart.startsWith("--runtime=") ||
		namesPart.startsWith("--runtime ")
	) {
		return null;
	}

	if (!namesPart) return null;

	const names = namesPart
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);

	if (names.length === 0) return null;
	return { names, task };
}

/**
 * Internal shared execution function used by both commands and tool.
 */
export async function executeAgentLaunch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentNames: string[],
	task: string,
	modelOverride?: string,
): Promise<void> {
	const { MAX_SUBAGENTS_PER_RUN } = await import("./types.js");
	const { runSingleAgent } = await import("./runner.js");
	const { runParallelAgents } = await import("./lib/parallel.js");
	const {
		createRun,
		updateStep,
		completeRun,
		failRun,
	} = await import("./history/status-store.js");
	const { randomUUID } = await import("node:crypto");

	if (agentNames.length > MAX_SUBAGENTS_PER_RUN) {
		ctx.ui.notify(
			`Too many agents (${agentNames.length}). Max is ${MAX_SUBAGENTS_PER_RUN}.`,
			"error",
		);
		return;
	}

	const agents = discoverAgents(ctx.cwd);

	// Validate all agent names
	const parentSessionId = ctx.sessionManager.getSessionId();
	const parentSessionName = pi.getSessionName();
	const parentIntercomTarget =
		parentSessionName?.trim() || defaultIntercomAlias(parentSessionId);

	const requests = agentNames.map((name, index) => {
		const agent = agents.find((a) => a.name === name);
		if (!agent) {
			throw new Error(
				`Unknown agent: ${name}. Available: ${agents.map((a) => a.name).join(", ")}`,
			);
		}
		// Label duplicates
		const count = agentNames.slice(0, index + 1).filter((n) => n === name).length;
		const label = count === 1 ? name : `${name}#${count}`;
		return {
			agent,
			label,
			index,
			parentSessionId,
			parentSessionName,
			parentIntercomTarget,
		};
	});

	const runId = randomUUID().slice(0, 8);
	const mode = requests.length === 1 ? "single" : "parallel";

	// Create history entry
	const steps = requests.map((r) => ({
		agent: r.agent.name,
		label: r.label,
		status: "pending" as const,
		runtime: "tmux" as const,
		executionMode: "interactive" as const,
		taskPreview: task.length > 140 ? `${task.slice(0, 137)}...` : task,
		configuredSkills: r.agent.skills,
	}));
	createRun(
		runId,
		mode,
		steps,
		ctx.cwd,
		"interactive",
		{ sessionId: parentSessionId, sessionName: parentSessionName },
	);

	if (ctx.hasUI) {
		const agentList = requests.map((r) => r.label).join(", ");
		ctx.ui.setStatus("subagent", `Running ${agentList}...`);
	}

	const runExecution = async (): Promise<void> => {
		try {
			if (requests.length === 1) {
				const r = requests[0]!;
				updateStep(runId, 0, { status: "running" });
				const result = await runSingleAgent({
					agent: r.agent,
					task,
					cwd: ctx.cwd,
					runId,
					modelOverride,
					index: 0,
					label: r.label,
					parentSessionId: r.parentSessionId,
					parentSessionName: r.parentSessionName,
					parentIntercomTarget: r.parentIntercomTarget,
					runtime: "tmux",
					executionMode: "interactive",
				});
				updateStep(runId, 0, {
					status: result.status === "ok" ? "ok" : "error",
					durationMs: result.durationMs,
					error: result.error,
					report: result.report,
					reportUpdatedAt: result.report ? Date.now() : undefined,
				});

				if (result.status === "ok") {
					completeRun(runId);
				} else {
					failRun(runId, result.error);
				}

				pi.sendMessage(buildSubagentReportMessage([result]));

				if (ctx.hasUI) {
					ctx.ui.notify(
						result.status === "ok"
							? `${r.label} finished (${formatDuration(result.durationMs)})`
							: `${r.label} stopped: ${result.error ?? "unknown error"}`,
						result.status === "ok" ? "info" : "warning",
					);
				}
			} else {
				for (let i = 0; i < requests.length; i++) {
					updateStep(runId, i, { status: "running" });
				}

				const results = await runParallelAgents(
					requests.map((r) => ({
						agent: r.agent,
						task,
						cwd: ctx.cwd,
						runId,
						modelOverride,
						index: r.index,
						label: r.label,
						parentSessionId: r.parentSessionId,
						parentSessionName: r.parentSessionName,
						parentIntercomTarget: r.parentIntercomTarget,
						runtime: "tmux",
						executionMode: "interactive",
					})),
				);

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

				const allOk = results.every((r) => r.status === "ok");
				if (allOk) {
					completeRun(runId);
				} else {
					failRun(runId);
				}

				pi.sendMessage(buildSubagentReportMessage(results));

				if (ctx.hasUI) {
					const okCount = results.filter((r) => r.status === "ok").length;
					ctx.ui.notify(
						`Interactive run: ${okCount}/${results.length} finished cleanly`,
						allOk ? "info" : "warning",
					);
				}
			}
		} catch (error) {
			failRun(
				runId,
				error instanceof Error ? error.message : String(error),
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Launch failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		} finally {
			if (ctx.hasUI) {
				ctx.ui.setStatus("subagent", undefined);
			}
		}
	};

	void runExecution();
	const labels = requests.map((r) => r.label).join(", ");
	pi.sendMessage({
		customType: "text",
		content:
			`🚀 Started interactive subagents in tmux (${labels})\n` +
			`Run: ${runId}\n` +
			"Started initial task in each pane. Pane auto-closes after a final report is captured. Use /subagents-status to monitor and control.",
		display: true,
	});
	if (ctx.hasUI) {
		ctx.ui.notify(`Started interactive tmux run ${runId}`, "info");
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

async function openSubagentsStatusOverlay(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) =>
			new SubagentsStatusComponent(
				tui,
				theme,
				() => done(undefined),
			),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 160,
				maxHeight: "92%",
			},
		},
	);
}

export function registerCommands(pi: ExtensionAPI): void {
	const agentCompletions = (prefix: string) => {
		const agents = discoverAgents(process.cwd());
		return agents
			.filter((a) => a.name.startsWith(prefix))
			.map((a) => ({ value: a.name, label: a.name }));
	};

	pi.registerCommand("run-agent", {
		description: "Run a single subagent: /run-agent <name> -- <task>",
		getArgumentCompletions: agentCompletions,
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed || parsed.names.length !== 1) {
				ctx.ui.notify(
					"Usage: /run-agent <name> -- <task>",
					"error",
				);
				return;
			}
			await executeAgentLaunch(
				pi,
				ctx,
				parsed.names,
				parsed.task,
			);
		},
	});

	pi.registerCommand("subagents-status", {
		description: "Show active and recent subagent runs",
		handler: async (_args, ctx) => {
			await openSubagentsStatusOverlay(ctx);
		},
	});

	try {
		pi.registerShortcut(Key.ctrlAlt("s"), {
			description: "Open subagents status",
			handler: async (ctx) => {
				await openSubagentsStatusOverlay(ctx);
			},
		});
	} catch {
		// Ignore shortcut registration conflicts so extension still loads.
	}
}
