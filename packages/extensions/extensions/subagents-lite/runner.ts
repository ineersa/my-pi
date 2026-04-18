/**
 * Single subagent runner (tmux interactive mode).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	SubagentRunRequest,
	SubagentRunResult,
} from "./types.js";
import { getPiSpawnCommand } from "./lib/pi-spawn.js";
import {
	applyThinkingSuffix,
	buildPiArgs,
	cleanupTempDir,
} from "./lib/pi-args.js";
import {
	createSidecarPaneStack,
	getPanePid,
	isTmuxAvailable,
	killPane,
	paneExists,
	sendCtrlCToPane,
	shellQuote,
	startPaneLogPipe,
	stopPaneLogPipe,
	tmuxOrThrow,
} from "./lib/tmux.js";

const TMUX_EXIT_MARKER = "__SUBAGENT_EXIT_CODE__:";
const AUTO_CLOSE_PANE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveRunDir(runId: string | undefined): Promise<string> {
	if (runId) {
		const { getRunsRoot } = await import("./history/status-store.js");
		const runDir = path.join(getRunsRoot(), runId);
		fs.mkdirSync(runDir, { recursive: true });
		return runDir;
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-"));
}

function extractExitCodeFromText(text: string): number | undefined {
	const matches = Array.from(text.matchAll(/__SUBAGENT_EXIT_CODE__:(-?\d+)/g));
	if (matches.length === 0) return undefined;
	const last = matches[matches.length - 1]!;
	return Number(last[1]);
}

async function waitForTmuxExit(
	logPath: string,
	paneId?: string,
	timeoutMs?: number,
	monitor?: { runId?: string; stepIndex?: number },
): Promise<{ exitCode: number; timedOut: boolean; completedByReport?: boolean }> {
	const startedAt = Date.now();
	let offset = 0;
	let carry = "";
	let exitCode: number | undefined;

	const parseChunk = (chunk: string): void => {
		const combined = carry + chunk;
		const lines = combined.split(/\r?\n/);
		carry = lines.pop() ?? "";
		for (const line of lines) {
			const match = line.match(/__SUBAGENT_EXIT_CODE__:(-?\d+)/);
			if (match) {
				exitCode = Number(match[1]);
			}
		}
		if (carry.includes(TMUX_EXIT_MARKER)) {
			const carryMatch = carry.match(/__SUBAGENT_EXIT_CODE__:(-?\d+)/);
			if (carryMatch) exitCode = Number(carryMatch[1]);
		}
	};

	while (true) {
		if (
			monitor?.runId &&
			typeof monitor.stepIndex === "number" &&
			monitor.stepIndex >= 0
		) {
			const { getRunStatus } = await import("./history/status-store.js");
			const run = getRunStatus(monitor.runId);
			const step = run?.steps[monitor.stepIndex];
			if (step && (step.status === "ok" || step.status === "error")) {
				return { exitCode: step.status === "ok" ? 0 : 1, timedOut: false, completedByReport: true };
			}
		}
		if (fs.existsSync(logPath)) {
			const stat = fs.statSync(logPath);
			if (stat.size > offset) {
				const readLen = stat.size - offset;
				const buf = Buffer.alloc(readLen);
				const fd = fs.openSync(logPath, "r");
				try {
					fs.readSync(fd, buf, 0, readLen, offset);
				} finally {
					fs.closeSync(fd);
				}
				offset = stat.size;
				parseChunk(buf.toString("utf8"));
				if (exitCode !== undefined) {
					return { exitCode, timedOut: false };
				}
			}
		}

		if (paneId && !paneExists(paneId)) {
			await sleep(300);
			if (fs.existsSync(logPath)) {
				const finalLog = fs.readFileSync(logPath, "utf8");
				const parsed = extractExitCodeFromText(finalLog);
				if (parsed !== undefined) {
					return { exitCode: parsed, timedOut: false };
				}
			}
			return { exitCode: 130, timedOut: false };
		}

		if (typeof timeoutMs === "number" && Date.now() - startedAt >= timeoutMs) {
			return { exitCode: 1, timedOut: true };
		}

		await sleep(250);
	}
}

function buildTmuxScript(input: {
	cwd: string;
	label: string;
	model: string;
	task: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}): string {
	const lines: string[] = [];
	lines.push("#!/usr/bin/env bash");
	lines.push("set +e");
	lines.push(`cd ${shellQuote(input.cwd)} || exit 1`);
	lines.push(`printf '%s\\n' ${shellQuote(`=== Starting Subagent: ${input.label} (${input.model}) ===`)}`);
	lines.push(`printf '%s\\n' ${shellQuote(`Task: ${input.task}`)}`);
	lines.push(`printf '%s\\n\\n' ${shellQuote("====================================================")}`);
	for (const [k, v] of Object.entries(input.env)) {
		lines.push(`export ${k}=${shellQuote(v)}`);
	}
	const cmd = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
	lines.push(cmd);
	lines.push("code=$?");
	lines.push("printf '\\n'");
	lines.push(`printf '${TMUX_EXIT_MARKER}%s\\n' "$code"`);
	lines.push("printf '=== Subagent Exited with code %s ===\\n' \"$code\"");
	lines.push("exit \"$code\"");
	return lines.join("\n") + "\n";
}

async function runSingleAgentTmux(
	request: SubagentRunRequest,
	timeoutMs?: number,
): Promise<SubagentRunResult> {
	const { agent, task, cwd, runId, modelOverride, label } = request;
	const startedAt = Date.now();
	const runtimeCwd = cwd ?? process.cwd();
	const modelArg = applyThinkingSuffix(modelOverride ?? agent.model, agent.thinking);

	if (!isTmuxAvailable()) {
		throw new Error("tmux is not available. Install tmux first.");
	}

	const { args, env: extraEnv, tempDir, skillsDebug } = buildPiArgs({
		task,
		model: modelOverride ?? agent.model,
		thinking: agent.thinking,
		tools: agent.tools,
		skills: agent.skills,
		cwd: runtimeCwd,
		fallbackCwd: process.cwd(),
		systemPrompt: agent.systemPrompt || null,
		mcpDirectTools: agent.mcpDirectTools,
		runtime: "tmux",
	});

	const runDir = await resolveRunDir(runId);
	const logPath = path.join(runDir, `${label}.log`);
	const scriptPath = path.join(runDir, `${label}.tmux.sh`);

	const tmuxEnv: Record<string, string> = {
		PI_SUBAGENT_DEPTH: String(Number(process.env.PI_SUBAGENT_DEPTH ?? "0") + 1),
		PI_SUBAGENT_DISABLE_SCHEDULER: "1",
		PI_SUBAGENT_CHILD: "1",
	};
	if (process.env.PI_SUBAGENT_MAX_DEPTH) {
		tmuxEnv.PI_SUBAGENT_MAX_DEPTH = process.env.PI_SUBAGENT_MAX_DEPTH;
	}
	if (runId) {
		tmuxEnv.PI_SUBAGENT_RUN_ID = runId;
		tmuxEnv.PI_SUBAGENT_STEP_INDEX = String(request.index);
		tmuxEnv.PI_SUBAGENT_LABEL = label;
	}
	if (request.parentIntercomTarget) {
		tmuxEnv.PI_SUBAGENT_PARENT_INTERCOM_TARGET = request.parentIntercomTarget;
	}
	for (const [k, v] of Object.entries(extraEnv)) {
		if (typeof v === "string" && v.length > 0) {
			tmuxEnv[k] = v;
		}
	}

	const spawnSpec = getPiSpawnCommand(args);
	const script = buildTmuxScript({
		cwd: runtimeCwd,
		label,
		model: modelArg ?? "default",
		task,
		command: spawnSpec.command,
		args: spawnSpec.args,
		env: tmuxEnv,
	});
	fs.writeFileSync(scriptPath, script, { mode: 0o700 });

	let paneId = request.tmuxTarget?.paneId ?? "";
	let windowId = request.tmuxTarget?.windowId ?? "";
	let sessionName = request.tmuxTarget?.sessionName ?? "";

	try {
		if (!paneId) {
			const pane = createSidecarPaneStack(1)[0];
			if (!pane?.paneId) {
				throw new Error("tmux did not return a pane id for sidecar split.");
			}
			paneId = pane.paneId;
			windowId = pane.windowId ?? "";
			sessionName = pane.sessionName ?? "";
		}

		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, "", "utf8");
		stopPaneLogPipe(paneId);
		if (!startPaneLogPipe(paneId, logPath)) {
			throw new Error(`failed to start tmux log pipe for pane ${paneId}`);
		}

		tmuxOrThrow(["send-keys", "-t", paneId, "-l", `bash ${shellQuote(scriptPath)}`]);
		tmuxOrThrow(["send-keys", "-t", paneId, "C-m"]);

		const panePid = getPanePid(paneId);
		if (runId) {
			const { updateStep } = await import("./history/status-store.js");
			updateStep(runId, request.index, {
				pid: panePid,
				runtime: "tmux",
				executionMode: "interactive",
				logPath,
				tmuxPaneId: paneId,
				tmuxWindowId: windowId || undefined,
				tmuxSessionName: sessionName || undefined,
				configuredSkills: skillsDebug?.configured,
				resolvedSkills: skillsDebug?.resolved,
				missingSkills: skillsDebug?.missing,
			});
		}

		const waited = await waitForTmuxExit(logPath, paneId, timeoutMs, {
			runId,
			stepIndex: request.index,
		});
		if (waited.timedOut) {
			sendCtrlCToPane(paneId);
		}

		const durationMs = Date.now() - startedAt;
		const isTimeout = waited.timedOut;
		const exitCode = isTimeout ? 1 : waited.exitCode;

		let report: string | undefined;
		let stepStatus: "ok" | "error" | undefined;
		if (runId) {
			const { getRunStatus } = await import("./history/status-store.js");
			const current = getRunStatus(runId);
			const step = current?.steps[request.index];
			report = step?.report;
			if (step?.status === "ok") {
				stepStatus = "ok";
			}
			if (step?.status === "error") {
				stepStatus = "error";
			}
		}

		const status = stepStatus ?? (waited.completedByReport ? "ok" : (exitCode === 0 ? "ok" : "error"));
		const error =
			status === "ok"
				? undefined
				: isTimeout
					? `Timed out after ${Math.round(durationMs / 1000)}s`
					: exitCode !== 0
						? `Exited with code ${exitCode}`
						: undefined;

		if (report?.trim() && paneId) {
			await sleep(AUTO_CLOSE_PANE_DELAY_MS);
			if (paneExists(paneId)) {
				killPane(paneId);
			}
		}

		return {
			agent: agent.name,
			task,
			label,
			status,
			exitCode,
			durationMs,
			output: "",
			error,
			model: modelArg,
			runtime: "tmux",
			executionMode: "interactive",
			logPath,
			tmuxPaneId: paneId,
			tmuxWindowId: windowId || undefined,
			tmuxSessionName: sessionName || undefined,
			report,
		};
	} finally {
		if (paneId) {
			stopPaneLogPipe(paneId);
		}
		cleanupTempDir(tempDir);
	}
}

export async function runSingleAgent(
	request: SubagentRunRequest,
	timeoutMs?: number,
): Promise<SubagentRunResult> {
	return runSingleAgentTmux(request, timeoutMs);
}
