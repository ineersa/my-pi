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
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents } from "./agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.ts";
import { renderSubagentResult } from "./render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "./subagent-executor.ts";
import {
	type Details,
	type ExtensionConfig,
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

export default function registerSubagentExtension(pi: ExtensionAPI): void {
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
