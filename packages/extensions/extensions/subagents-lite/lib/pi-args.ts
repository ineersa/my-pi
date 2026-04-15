/**
 * Build command-line arguments for a pi child process.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSkillInjection,
	resolveSkillsWithFallback,
} from "./skills.js";

const TASK_ARG_LIMIT = 8000;

function buildDelegatedTaskPrompt(task: string): string {
	return [
		"You are a delegated subagent in an orchestrated run.",
		"Work autonomously and return a complete final report in your next assistant reply.",
		"Prefer concrete findings with file paths/commands when relevant.",
		"",
		"Task:",
		task,
	].join("\n");
}

export interface BuildPiArgsInput {
	task: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	cwd?: string;
	fallbackCwd?: string;
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	runtime?: "tmux";
}

export interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
	skillsDebug?: {
		configured: string[];
		resolved: string[];
		missing: string[];
	};
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | undefined,
): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (
		colonIdx !== -1 &&
		THINKING_LEVELS.includes(model.substring(colonIdx + 1))
	)
		return model;
	return `${model}:${thinking}`;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = ["--no-session"];

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	if (input.tools?.length) {
		args.push("--tools", input.tools.join(","));
	}

	const configuredSkills = (input.skills ?? []).map((s) => s.trim()).filter(Boolean);
	const skillPrimaryCwd = input.cwd ?? process.cwd();
	const skillFallbackCwd = input.fallbackCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		configuredSkills,
		skillPrimaryCwd,
		skillFallbackCwd,
	);
	const skillInjection = buildSkillInjection(resolvedSkills);

	// We inject resolved skills directly into the system prompt.
	// Keep child runtime skill discovery disabled for deterministic behavior.
	args.push("--no-skills");

	const combinedSystemPrompt = [input.systemPrompt?.trim() ?? "", skillInjection]
		.filter(Boolean)
		.join("\n\n")
		.trim();

	let tempDir: string | undefined;
	if (combinedSystemPrompt) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const promptPath = path.join(tempDir, "system-prompt.md");
		fs.writeFileSync(promptPath, combinedSystemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}

	const delegatedTask = buildDelegatedTaskPrompt(input.task);
	if (delegatedTask.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, delegatedTask, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(delegatedTask);
	}

	const env: Record<string, string | undefined> = {};
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	}

	return {
		args,
		env,
		tempDir,
		skillsDebug: {
			configured: configuredSkills,
			resolved: resolvedSkills.map((s) => s.name),
			missing: missingSkills,
		},
	};
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best effort
	}
}
