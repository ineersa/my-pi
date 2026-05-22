import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpAccess } from "./types.ts";
import { resolveConfiguredDirectToolNames, visibleToolToEnvSpec } from "./mcp-tools.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(EXTENSION_DIR, "subagent-prompt-runtime.ts");
const SUBAGENT_EXTENSION_PATH = path.join(EXTENSION_DIR, "index.ts");
const MCP_ADAPTER_EXTENSION_PATH = path.join(EXTENSION_DIR, "..", "pi-mcp-adapter", "pi-mcp-adapter.ts");

export interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	tools?: string[];
	extensions?: string[];
	systemPrompt?: string | null;
	mcpAccess?: McpAccess;
	promptFileStem?: string;
	/** Path for child result artifact (sets PI_SUBAGENT_RESULT_PATH). Child writes final result here. */
	childResultPath?: string;
}

export interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	// ------------------------------------------------------------------
	// Build --tools allowlist: builtins + optional ToolSearch + optional MCP direct tool names
	// ------------------------------------------------------------------
	const toolExtensionPaths: string[] = [];
	const mcpAccess = input.mcpAccess ?? { kind: "none" as const };

	// Collect tool names that go into --tools (non-extension-path entries)
	const toolsAllowlist: string[] = [];

	if (input.tools?.length) {
		for (const tool of input.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				toolsAllowlist.push(tool);
			}
		}
	}

	// Add MCP-related entries to the allowlist based on access mode
	if (mcpAccess.kind === "specific") {
		// Case B: specific MCP tools — add their visible names directly
		for (const spec of mcpAccess.specs) {
			// specs are visible tool names like "websearch__search"
			toolsAllowlist.push(spec);
		}
	} else if (mcpAccess.kind === "all") {
		// Case C: mcp:* — add ToolSearch so child can discover deferred MCP tools
		toolsAllowlist.push("ToolSearch");

		// Also resolve configured direct tool names (best-effort)
		const configuredDirectNames = resolveConfiguredDirectToolNames();
		for (const name of configuredDirectNames) {
			if (!toolsAllowlist.includes(name)) {
				toolsAllowlist.push(name);
			}
		}
	}
	// Case A (kind === "none"): no MCP entries added to allowlist

	if (toolsAllowlist.length > 0) {
		args.push("--tools", toolsAllowlist.join(","));
	}

	// ------------------------------------------------------------------
	// Extensions: runtime hooks + tool extension paths + user-specified extensions
	// ------------------------------------------------------------------
	const runtimeExtensions = [PROMPT_RUNTIME_EXTENSION_PATH, SUBAGENT_EXTENSION_PATH];
	if (mcpAccess.kind !== "none") {
		runtimeExtensions.push(MCP_ADAPTER_EXTENSION_PATH);
	}
	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...input.extensions])]) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths])]) {
			args.push("--extension", extPath);
		}
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	// ------------------------------------------------------------------
	// System prompt
	// ------------------------------------------------------------------
	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	// ------------------------------------------------------------------
	// Task
	// ------------------------------------------------------------------
	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	// ------------------------------------------------------------------
	// Environment
	// ------------------------------------------------------------------
	const env: Record<string, string | undefined> = {};
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";

	// MCP_DIRECT_TOOLS + subagent MCP gating: three cases
	if (mcpAccess.kind === "specific") {
		// Case B: explicit env specs (visible → server/tool format)
		const envSpecs = mcpAccess.specs.map(visibleToolToEnvSpec);
		env.MCP_DIRECT_TOOLS = envSpecs.join(",");
		env.PI_SUBAGENT_MCP_MODE = "specific";
	} else if (mcpAccess.kind === "all") {
		// Case C: do NOT set MCP_DIRECT_TOOLS (let pi-mcp-adapter use config-defined directTools)
		// env.MCP_DIRECT_TOOLS remains undefined
		env.PI_SUBAGENT_MCP_MODE = "all";
	} else {
		// Case A: no MCP — explicitly disable direct tools and all MCP
		env.MCP_DIRECT_TOOLS = "__none__";
		env.PI_SUBAGENT_MCP_MODE = "none";
	}

	// Child result artifact env vars (deterministic subagent result contract)
	if (input.childResultPath) {
		env.PI_SUBAGENT_CHILD = "1";
		env.PI_SUBAGENT_RESULT_PATH = input.childResultPath;
		env.PI_OFFLINE = "1";
		env.PI_SUBAGENT_DISABLE_SCHEDULER = "1";
		env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
		env.PI_FORK_DISABLE = "1";
	}

	return { args, env, tempDir };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
