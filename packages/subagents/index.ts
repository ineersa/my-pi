/**
 * Subagent Tool
 *
 * Full-featured subagent with sync mode.
 * - Sync (default): Streams output, renders Markdown, tracks usage
 *
 * Modes: single (agent + task), parallel (tasks[])
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "maxSubagentDepth": 1 }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.ts";
import { renderSubagentResult } from "./render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "./subagent-executor.ts";
import {
	type Details,
	type ExtensionConfig,
	type SubagentChildResult,
	type SubagentState,
	DEFAULT_ARTIFACT_CONFIG,
} from "./types.ts";

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function collectChildUsage(messages: unknown[]): {
	input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number;
} {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const u = (message as Record<string, unknown>).usage as Record<string, unknown> | undefined;
		if (!u) continue;
		usage.input += typeof u.input === "number" ? u.input : 0;
		usage.output += typeof u.output === "number" ? u.output : 0;
		usage.cacheRead += typeof u.cacheRead === "number" ? u.cacheRead : 0;
		usage.cacheWrite += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
		const costVal = u.cost;
		usage.cost += typeof costVal === "number"
			? costVal
			: typeof costVal === "object" && costVal !== null && typeof (costVal as Record<string, unknown>).total === "number"
				? ((costVal as Record<string, number>).total)
				: 0;
		usage.turns++;
	}
	return usage;
}

function getLastAssistantMetadata(messages: unknown[]): {
	provider?: string; model?: string; stopReason?: string;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "assistant") continue;
		return {
			provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
			model: typeof candidate.model === "string" ? candidate.model : undefined,
			stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
		};
	}
	return {};
}

function writeSubagentChildResult(messages: unknown[]): void {
	const resultPath = process.env.PI_SUBAGENT_RESULT_PATH?.trim();
	if (!resultPath) return;

	const safeMessages = Array.isArray(messages) ? messages : [];
	const metadata = getLastAssistantMetadata(safeMessages);

	const result: SubagentChildResult = {
		task: process.env.PI_SUBAGENT_TASK ?? "",
		exitCode: 0,
		messages: safeMessages as import("@earendil-works/pi-ai").Message[],
		usage: collectChildUsage(safeMessages),
		model: metadata.model,
		provider: metadata.provider,
		stopReason: metadata.stopReason,
		finalOutput: undefined, // parent extracts finalOutput from messages
		sawAgentEnd: true,
	};

	fs.mkdirSync(path.dirname(resultPath), { recursive: true });
	const tmpPath = `${resultPath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2), "utf-8");
	fs.renameSync(tmpPath, resultPath);
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	// ── Child mode: register only passive hooks, no subagent tool ──
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		let agentCompleted = false;
		let resultWritten = false;
		const finalizedMessages: unknown[] = [];

		const pushFinalizedMessage = (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const role = (message as Record<string, unknown>).role;
			if (role === "user") return;
			finalizedMessages.push(message);
		};

		const finishSuccess = () => {
			if (resultWritten) return;
			resultWritten = true;
			writeSubagentChildResult(finalizedMessages);
			setTimeout(() => {
				process.exit(0);
			}, 300);
		};

		pi.on("message_end", (event) => {
			pushFinalizedMessage((event as unknown as Record<string, unknown>).message);
		});

		pi.on("turn_end", (event) => {
			const record = event as unknown as Record<string, unknown>;
			const message = record.message as Record<string, unknown> | undefined;
			const toolResults = Array.isArray(record.toolResults) ? record.toolResults : [];
			if (message?.role === "assistant" && toolResults.length === 0) {
				finishSuccess();
			}
		});

		pi.on("agent_end", () => {
			if (agentCompleted) return;
			agentCompleted = true;
			finishSuccess();
		});

		pi.on("session_shutdown", () => {
			process.exit(resultWritten ? 0 : 1);
		});

		return;
	}

	const config = loadConfig();
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: process.cwd(),
		currentSessionId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
	};

	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
	});

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: `Delegate tasks to subagents or run agents in parallel.

EXECUTION (use exactly ONE mode):
• SINGLE: { agent, task } - one task
• PARALLEL: { tasks: [{agent,task,count?}, ...], concurrency?: number } - concurrent execution
• Optional context: { context: "fresh" | "fork" } (default: "fresh")

Example: { agent: "scout", task: "Analyze the codebase" } or { tasks: [{agent:"scout"}, {agent:"worker"}] }`,
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as import("./subagent-executor.ts").SubagentParamsLike, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},

	};

	pi.registerTool(tool);

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
	});
	pi.on("session_shutdown", () => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
	});
}
