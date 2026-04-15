import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * jetbrains-symbol-nudge
 *
 * Serena-inspired drift guard:
 * - watches tool usage during an agent run
 * - if the model keeps using generic/file-level tools without symbol-first IDE ops,
 *   nudges with guidance
 * - works with both direct MCP tools and proxy mode (mcp tool)
 */
export default function jetbrainsSymbolNudgeExtension(pi: ExtensionAPI): void {
	const BUILTIN_GENERIC_TOOLS = new Set<string>(["read", "grep", "find", "ls", "bash"]);
	const PROXY_DISCOVERY_WORKFLOW = [
		"JetBrains MCP is running in proxy mode via the mcp tool.",
		"Important: mcp(...) is a TOOL call, not a shell command. Never run it via bash.",
		"",
		"Discovery workflow (tool calls):",
		"1) Call mcp with connect=\"jetbrains\"",
		"2) Call mcp with server=\"jetbrains\"",
		"3) Call mcp with describe=\"jetbrains_<tool>\" to load exact parameter schema",
		"4) Call mcp with tool=\"jetbrains_<tool>\" and args as JSON string",
	].join("\n");

	const PROXY_RECONNECT_NOTIFY =
		"JetBrains MCP proxy mode: consider /mcp reconnect jetbrains once after startup to refresh tool metadata.";

	const GENERIC_SUFFIXES = new Set<string>();

	const SYMBOLIC_SUFFIXES = new Set<string>([
		"search_symbol",
		"get_symbol_info",
		"search_structural",
		"rename_refactoring",
	]);

	const SEARCH_NUDGE_THRESHOLD = 3;
	const PROBLEMS_NUDGE_THRESHOLD = 5;
	const COOLDOWN_MS = 2 * 60 * 1000;
	const SEARCH_BASH_REGEX = /\b(?:rg|grep|git\s+grep|find)\b/i;

	type ToolCapabilities = {
		hasMcp: boolean;
		proxyOnly: boolean;
		hasSearchSymbol: boolean;
		hasSymbolInfo: boolean;
		hasStructuralSearch: boolean;
		hasStructuralPatterns: boolean;
		hasRenameRefactoring: boolean;
		hasFileProblems: boolean;
	};

	let genericStreak = 0;
	let usedSymbolicThisRun = false;
	let lastNudgeAt = 0;
	let nudgesSent = 0;

	let writeStreak = 0;
	let lastProblemsNudgeAt = 0;
	let problemsNudgesSent = 0;

	function resetRunState(): void {
		genericStreak = 0;
		usedSymbolicThisRun = false;
	}

	function resetSessionState(): void {
		resetRunState();
		writeStreak = 0;
	}

	function canNudgeNow(): boolean {
		return Date.now() - lastNudgeAt >= COOLDOWN_MS;
	}

	function canProblemsNudgeNow(): boolean {
		return Date.now() - lastProblemsNudgeAt >= COOLDOWN_MS;
	}

	function getToolSuffix(toolName: string): string {
		const idx = toolName.lastIndexOf("_");
		if (idx === -1) return toolName;

		const parts = toolName.split("_");
		if (parts.length >= 2) {
			const maybeSuffix2 = `${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
			if (SYMBOLIC_SUFFIXES.has(maybeSuffix2) || GENERIC_SUFFIXES.has(maybeSuffix2)) {
				return maybeSuffix2;
			}
		}
		if (parts.length >= 3) {
			const maybeSuffix3 = `${parts[parts.length - 3]}_${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
			if (SYMBOLIC_SUFFIXES.has(maybeSuffix3) || GENERIC_SUFFIXES.has(maybeSuffix3)) {
				return maybeSuffix3;
			}
		}
		if (parts.length >= 4) {
			const maybeSuffix4 = `${parts[parts.length - 4]}_${parts[parts.length - 3]}_${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
			if (SYMBOLIC_SUFFIXES.has(maybeSuffix4) || GENERIC_SUFFIXES.has(maybeSuffix4)) {
				return maybeSuffix4;
			}
		}

		return parts[parts.length - 1] ?? toolName;
	}

	function resolveEffectiveToolName(event: { toolName: string; input: Record<string, unknown> }): string {
		if (event.toolName !== "mcp") return event.toolName;

		const proxyTool = event.input?.tool;
		if (typeof proxyTool === "string" && proxyTool.trim().length > 0) {
			return proxyTool.trim();
		}

		return event.toolName;
	}

	function isSymbolicTool(name: string): boolean {
		const suffix = getToolSuffix(name);
		return SYMBOLIC_SUFFIXES.has(suffix);
	}

	function isGenericTool(name: string): boolean {
		if (BUILTIN_GENERIC_TOOLS.has(name)) return true;
		const suffix = getToolSuffix(name);
		return GENERIC_SUFFIXES.has(suffix);
	}

	function hasToolEnding(activeTools: string[], suffix: string): boolean {
		return activeTools.some((name) => name === suffix || name.endsWith(`_${suffix}`));
	}

	function getToolCapabilities(): ToolCapabilities {
		const activeTools = pi.getActiveTools();
		const hasMcp = activeTools.includes("mcp");
		const hasDirectJetBrains = activeTools.some((name) =>
			name.startsWith("jetbrains_") || name.startsWith("phpstorm_"),
		);

		return {
			hasMcp,
			proxyOnly: hasMcp && !hasDirectJetBrains,
			hasSearchSymbol: hasToolEnding(activeTools, "search_symbol"),
			hasSymbolInfo: hasToolEnding(activeTools, "get_symbol_info"),
			hasStructuralSearch: hasToolEnding(activeTools, "search_structural"),
			hasStructuralPatterns: hasToolEnding(activeTools, "get_structural_patterns"),
			hasRenameRefactoring: hasToolEnding(activeTools, "rename_refactoring"),
			hasFileProblems: hasToolEnding(activeTools, "get_file_problems"),
		};
	}

	function hasSymbolGuidanceTarget(capabilities: ToolCapabilities): boolean {
		return capabilities.proxyOnly
			|| capabilities.hasSearchSymbol
			|| capabilities.hasSymbolInfo
			|| capabilities.hasStructuralSearch
			|| capabilities.hasRenameRefactoring;
	}

	function hasProblemsGuidanceTarget(capabilities: ToolCapabilities): boolean {
		return capabilities.proxyOnly || capabilities.hasFileProblems;
	}

	function wrapSystemReminder(content: string): string {
		return `<system-reminder>\n${content}\n</system-reminder>`;
	}

	function getGenericIncrement(toolName: string, bashCommand: string): number {
		if (toolName === "read") return 2;
		if (toolName === "bash" && SEARCH_BASH_REGEX.test(bashCommand)) return 2;
		return 1;
	}

	function describeGenericTool(toolName: string, bashCommand: string): string {
		if (toolName === "read") return "read";
		if (toolName === "bash" && SEARCH_BASH_REGEX.test(bashCommand)) {
			const trimmed = bashCommand.trim().replace(/\s+/g, " ");
			const preview = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
			return `bash (${preview})`;
		}
		return toolName;
	}

	function buildSystemPromptHint(capabilities: ToolCapabilities): string {
		const lines: string[] = [];

		if (capabilities.proxyOnly) {
			lines.push(PROXY_DISCOVERY_WORKFLOW, "");
		}

		lines.push(
			"JetBrains Tools & Usage Guidelines:",
			"",
			"IDE PREFERENCE: ALWAYS prefer JetBrains tools over bash `grep`, `rg`, or `find` for symbol operations and structured search.",
			"Only nudge toward tools that are actually available in this session.",
		);

		let section = 1;
		const addSection = (title: string, body: string[]) => {
			if (body.length === 0) return;
			lines.push("", `${section}. ${title}`, ...body);
			section += 1;
		};

		addSection(
			"CODE NAVIGATION (Primary Tools)",
			[
				...(capabilities.proxyOnly || capabilities.hasSearchSymbol
					? ["- *_search_symbol: find classes, methods, and fields quickly."]
					: []),
				...(capabilities.proxyOnly || capabilities.hasSymbolInfo
					? ["- *_get_symbol_info: inspect declaration/signature/docs."]
					: []),
			],
		);

		addSection(
			"STRUCTURAL SEARCH (Semantic code patterns)",
			[
				...(capabilities.proxyOnly || capabilities.hasStructuralSearch
					? ["- *_search_structural (if supported): semantic AST pattern search."]
					: []),
				...(capabilities.proxyOnly || capabilities.hasStructuralPatterns
					? ["- *_get_structural_patterns (if supported): discover known SSR templates."]
					: []),
			],
		);

		addSection(
			"REFACTORING & EDITING",
			capabilities.proxyOnly || capabilities.hasRenameRefactoring
				? ["- *_rename_refactoring: safe symbol rename across references."]
				: [],
		);

		addSection(
			"ANALYSIS",
			capabilities.proxyOnly || capabilities.hasFileProblems
				? ["- *_get_file_problems: run IDE inspections after edits."]
				: [],
		);

		lines.push(
			"",
			"Decision rules:",
			"- ALWAYS prefer available JetBrains tools over bash `grep`/`rg`/`find` for code navigation and refactoring.",
		);

		if (capabilities.proxyOnly || capabilities.hasSearchSymbol || capabilities.hasSymbolInfo) {
			lines.push("- ALWAYS prefer *_search_symbol / *_get_symbol_info before text/regex for navigation.");
		}
		if (capabilities.proxyOnly || capabilities.hasRenameRefactoring) {
			lines.push("- ALWAYS prefer *_rename_refactoring over manual text replacement for symbol renames.");
		}
		if (capabilities.proxyOnly || capabilities.hasFileProblems) {
			lines.push("- ALWAYS use *_get_file_problems to check files after making modifications.");
		}
		if (capabilities.proxyOnly) {
			lines.push("- If args are uncertain, ALWAYS call mcp describe first.");
		}

		return lines.join("\n");
	}

	function buildReason(toolName: string, capabilities: ToolCapabilities): string {
		const suggestions = [
			...(capabilities.proxyOnly || capabilities.hasSearchSymbol
				? ["- *_search_symbol (find class/method/field)"]
				: []),
			...(capabilities.proxyOnly || capabilities.hasSymbolInfo
				? ["- *_get_symbol_info (inspect declaration/signature/docs)"]
				: []),
			...(capabilities.proxyOnly || capabilities.hasStructuralSearch
				? ["- *_search_structural (semantic code pattern search, when available)"]
				: []),
			...(capabilities.proxyOnly || capabilities.hasRenameRefactoring
				? ["- *_rename_refactoring (safe symbol rename)"]
				: []),
		];

		if (suggestions.length === 0) {
			suggestions.push("- No symbol-first JetBrains tools are currently available in this session.");
		}

		return wrapSystemReminder(
			[
				`System Nudge: You are using generic tools (${toolName}) frequently.`,
				"Please use available JetBrains symbol-first tools for better precision:",
				...suggestions,
				"Prefer these over plain text or regex searches for code navigation.",
			].join("\n"),
		);
	}

	function buildProblemsReason(capabilities: ToolCapabilities): string {
		const suggestedTool = capabilities.hasFileProblems
			? "`jetbrains_get_file_problems`"
			: "`*_get_file_problems` (if available)";

		return wrapSystemReminder(
			[
				"System Nudge: You have made several file modifications.",
				`Please use ${suggestedTool} to check edited files for syntax errors or linting issues.`,
				"This helps identify problems early and ensures the code remains valid.",
			].join("\n"),
		);
	}

	pi.on("session_start", (_event, ctx) => {
		resetSessionState();
		if (ctx.hasUI && getToolCapabilities().proxyOnly) {
			ctx.ui.notify(PROXY_RECONNECT_NOTIFY, "info");
		}
	});

	pi.on("turn_start", () => {
		resetRunState();
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${wrapSystemReminder(buildSystemPromptHint(getToolCapabilities()))}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const bashCommand = event.toolName === "bash" ? String(input.command ?? "") : "";

		if (event.toolName === "bash" && /\bmcp\s*\(\s*\{/.test(bashCommand)) {
			return {
				block: true,
				reason: "Detected mcp(...) executed via bash. Use the mcp tool directly, not shell syntax.",
			};
		}

		const effectiveToolName = resolveEffectiveToolName({
			toolName: event.toolName,
			input,
		});

		const capabilities = getToolCapabilities();

		if (effectiveToolName.endsWith("get_file_problems")) {
			writeStreak = 0;
		} else if (effectiveToolName === "write" || effectiveToolName === "edit") {
			writeStreak += 1;
			if (
				writeStreak >= PROBLEMS_NUDGE_THRESHOLD
				&& canProblemsNudgeNow()
				&& hasProblemsGuidanceTarget(capabilities)
			) {
				writeStreak = 0;
				lastProblemsNudgeAt = Date.now();
				problemsNudgesSent += 1;

				if (ctx.hasUI) {
					ctx.ui.notify("🧭 Problems nudge: steering model to check edited files", "warning");
				}

				pi.sendUserMessage(buildProblemsReason(capabilities), { deliverAs: "steer" });
			}
		}

		if (isSymbolicTool(effectiveToolName)) {
			usedSymbolicThisRun = true;
			genericStreak = 0;
			return;
		}

		if (!isGenericTool(effectiveToolName)) return;
		if (!hasSymbolGuidanceTarget(capabilities)) return;

		const genericToolLabel = describeGenericTool(effectiveToolName, bashCommand);
		genericStreak += getGenericIncrement(effectiveToolName, bashCommand);

		if (usedSymbolicThisRun) return;
		if (genericStreak < SEARCH_NUDGE_THRESHOLD) return;
		if (!canNudgeNow()) return;

		lastNudgeAt = Date.now();
		nudgesSent += 1;
		genericStreak = 0;

		if (ctx.hasUI) {
			ctx.ui.notify("🧭 Symbol nudge: steering model toward JetBrains symbol tools", "warning");
		}

		pi.sendUserMessage(buildReason(genericToolLabel, capabilities), { deliverAs: "steer" });
	});

	const handler = async (args: string, ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
		const action = (args || "status").trim().toLowerCase();

		if (action === "reset") {
			resetSessionState();
			lastNudgeAt = 0;
			nudgesSent = 0;
			lastProblemsNudgeAt = 0;
			problemsNudgesSent = 0;
			ctx.ui.notify("jetbrains-nudge state reset", "info");
			return;
		}

		const capabilities = getToolCapabilities();
		const capabilitiesLine = capabilities.proxyOnly
			? "capabilities: proxy mode (discover concrete tools via mcp server metadata)"
			: [
				`search_symbol=${capabilities.hasSearchSymbol ? "yes" : "no"}`,
				`symbol_info=${capabilities.hasSymbolInfo ? "yes" : "no"}`,
				`search_structural=${capabilities.hasStructuralSearch ? "yes" : "no"}`,
				`structural_patterns=${capabilities.hasStructuralPatterns ? "yes" : "no"}`,
				`rename_refactoring=${capabilities.hasRenameRefactoring ? "yes" : "no"}`,
				`get_file_problems=${capabilities.hasFileProblems ? "yes" : "no"}`,
			].join(", ");

		ctx.ui.notify(
			[
				"jetbrains-nudge: always-on (proxy mode aware)",
				`generic streak: ${genericStreak}/${SEARCH_NUDGE_THRESHOLD}`,
				`write streak: ${writeStreak}/${PROBLEMS_NUDGE_THRESHOLD}`,
				`used symbolic this run: ${usedSymbolicThisRun ? "yes" : "no"}`,
				`symbol nudges sent: ${nudgesSent}`,
				`problems nudges sent: ${problemsNudgesSent}`,
				capabilitiesLine,
			].join("\n"),
			"info",
		);
	};

	pi.registerCommand("jetbrains-nudge", {
		description: "Show JetBrains symbol-usage nudge status (reset|status)",
		handler,
	});

	// Backward-compatible alias
	pi.registerCommand("symbol-nudge", {
		description: "Alias for /jetbrains-nudge",
		handler,
	});
}
