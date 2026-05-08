/**
 * Slash commands: /run-agent
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agent-registry.js";
import { buildSubagentReportMessage } from "./reporting.js";

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
	const { runSingleAgent } = await import("./runner.js");
	const {
		createRun,
		updateStep,
		completeRun,
		failRun,
		countRunningSubagents,
		MAX_CONCURRENT_SUBAGENTS,
	} = await import("./history/status-store.js");
	const { randomUUID } = await import("node:crypto");

	if (agentNames.length > 1) {
		ctx.ui.notify(
			`Only 1 agent per /run-agent command (got ${agentNames.length}).`,
			"error",
		);
		return;
	}

	// Enforce global concurrent cap
	const runningCount = countRunningSubagents();
	if (runningCount >= MAX_CONCURRENT_SUBAGENTS) {
		ctx.ui.notify(
			`Cannot launch — ${runningCount} subagent${runningCount === 1 ? "" : "s"} already running (max ${MAX_CONCURRENT_SUBAGENTS}). Wait for one to finish.`,
			"error",
		);
		return;
	}

	const agents = discoverAgents(ctx.cwd);

	const parentSessionId = ctx.sessionManager.getSessionId();
	const parentSessionName = pi.getSessionName();
	const parentIntercomTarget =
		parentSessionName?.trim() || defaultIntercomAlias(parentSessionId);

	const agent = agents.find((a) => a.name === agentNames[0]);
	if (!agent) {
		ctx.ui.notify(
			`Unknown agent: ${agentNames[0]}. Available: ${agents.map((a) => a.name).join(", ")}`,
			"error",
		);
		return;
	}
	const label = agent.name;

	const runId = randomUUID().slice(0, 8);

	createRun(
		runId,
		"single",
		[{
			agent: agent.name,
			label,
			status: "pending" as const,
			runtime: "tmux" as const,
			executionMode: "interactive" as const,
			taskPreview: task.length > 140 ? `${task.slice(0, 137)}...` : task,
			configuredSkills: agent.skills,
		}],
		ctx.cwd,
		"interactive",
		{ sessionId: parentSessionId, sessionName: parentSessionName },
	);

	if (ctx.hasUI) {
		ctx.ui.setStatus("subagent", `Running ${label}...`);
	}

	const runExecution = async (): Promise<void> => {
		try {
			updateStep(runId, 0, { status: "running" });
			const result = await runSingleAgent({
				agent,
				task,
				cwd: ctx.cwd,
				runId,
				modelOverride,
				index: 0,
				label,
				parentSessionId,
				parentSessionName,
				parentIntercomTarget,
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
						? `${label} finished (${formatDuration(result.durationMs)})`
						: `${label} stopped: ${result.error ?? "unknown error"}`,
					result.status === "ok" ? "info" : "warning",
				);
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
	pi.sendMessage({
		customType: "text",
		content:
			`🚀 Started interactive subagent in tmux (${label})\n` +
			`Run: ${runId}\n` +
			"Started initial task in the pane. Pane auto-closes after a final report is captured. Manage live runs directly from tmux panes.",
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
}
