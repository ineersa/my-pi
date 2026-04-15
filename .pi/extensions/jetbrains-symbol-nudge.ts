import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * jetbrains-symbol-nudge
 *
 * Serena-inspired drift guard:
 * - watches tool usage during an agent run
 * - if the model keeps using generic/file-level tools without symbol-first IDE ops,
 *   blocks one generic call with a guidance reason
 * - works with both direct MCP tools and proxy mode (mcp tool)
 */
export default function jetbrainsSymbolNudgeExtension(pi: ExtensionAPI): void {
	const BUILTIN_GENERIC_TOOLS = new Set<string>(["read", "grep", "find", "ls", "bash"]);
	const PROXY_DISCOVERY_HINT = [
		"JetBrains MCP is running in proxy mode via the mcp tool.",
		"Important: mcp(...) is a TOOL call, not a shell command. Never run it via bash.",
		"",
		"Discovery workflow (tool calls):",
		"1) Call mcp with connect=\"jetbrains\"",
		"2) Call mcp with server=\"jetbrains\"",
		"3) Call mcp with describe=\"jetbrains_<tool>\" to load exact parameter schema",
		"4) Call mcp with tool=\"jetbrains_<tool>\" and args as JSON string",
		"",
		"JetBrains Tools & Usage Guidelines:",
		"",
		"IDE PREFERENCE: ALWAYS prefer JetBrains tools over bash `grep`, `rg`, or `find` for symbol operations and structured search.",
		"The IDE tools are backed by the AST index. They are orders of magnitude faster, more precise, ignore comments/strings, and automatically exclude node_modules/build folders.",
		"",
		"1. CODE NAVIGATION (Primary Tools):",
		"- jetbrains_search_symbol: Searches for symbols (classes, methods, fields).",
		"  WHEN: You know the name (or part of it) of a class, method, or field.",
		"  WHY: Provides instant exact file, line, column, and code snippets. Far superior to grepping across files.",
		"  EXAMPLE: jetbrains_search_symbol with q: 'UserController'",
		"- jetbrains_get_symbol_info: Retrieves information about the symbol at the specified position.",
		"  WHEN: You need to understand a symbol's API, arguments, return type, or documentation.",
		"  WHY: Provides full semantic context without reading the entire file, similar to Quick Documentation.",
		"  EXAMPLE: jetbrains_get_symbol_info for filePath 'src/main.ts', line 10, column 15",
		"",
		"2. STRUCTURAL SEARCH (Semantic code patterns):",
		"- jetbrains_search_structural: Searches for code patterns using Structural Search (SSR).",
		"  WHEN: Looking for specific syntax structures (e.g., method calls, assignments, variable declarations).",
		"  WHY: Understands AST semantically, captures variables, and cleanly ignores text strings or comments. Completely replaces complex regex searches.",
		"  EXAMPLE: jetbrains_search_structural with pattern: 'let $var$ = 0;', fileType: 'TypeScript'",
		"- jetbrains_get_structural_patterns: Lists predefined structural search patterns with descriptions.",
		"  WHEN: You need reference for creating custom SSR patterns.",
		"  WHY: Provides common search templates for general, expressions, and suspicious code.",
		"",
		"3. REFACTORING & EDITING:",
		"- jetbrains_rename_refactoring: Renames a symbol (variable, function, class, etc.) in the specified file.",
		"  WHEN: Renaming programmatic symbols.",
		"  WHY: Intelligently updates ALL references throughout the project ensuring code integrity.",
		"  EXAMPLE: jetbrains_rename_refactoring for pathInProject 'app.ts', symbolName: 'oldName', newName: 'NewName'",
		"",
		"4. ANALYSIS:",
		"- jetbrains_get_file_problems: Analyzes the specified file for errors and warnings using IntelliJ's inspections.",
		"  WHEN: Checking a file for syntax errors, type errors, or linting issues after edits.",
		"  WHY: Helps identify coding issues and problems early.",
		"  EXAMPLE: jetbrains_get_file_problems for filePath 'src/app.ts'",
		"",
		"Decision rules:",
		"- ALWAYS prefer JetBrains tools over bash `grep`/`rg`/`find` for code navigation and refactoring.",
		"- ALWAYS prefer jetbrains_search_symbol / jetbrains_get_symbol_info before text/regex for navigation.",
		"- ALWAYS prefer jetbrains_rename_refactoring over manual text replacement for symbol renames.",
		"- ALWAYS use jetbrains_get_file_problems to check files after making modifications.",
		"- If args are uncertain, ALWAYS call describe first.",
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

	const THRESHOLD = 5;
	const COOLDOWN_MS = 2 * 60 * 1000;

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

	function isProxyOnlyMode(): boolean {
		const active = pi.getActiveTools();
		const hasMcp = active.includes("mcp");
		const hasDirectJetBrains = active.some((name) =>
			name.startsWith("jetbrains_") || name.startsWith("phpstorm_"),
		);
		return hasMcp && !hasDirectJetBrains;
	}

	function buildReason(toolName: string): string {
		return [
			`System Nudge: You are using generic tools (${toolName}) frequently.`,
			"Please use JetBrains symbol-first tools instead for better precision:",
			"- *_search_symbol (find class/method/field)",
			"- *_get_symbol_info (inspect declaration/signature/docs)",
			"- *_search_structural (semantic code pattern search)",
			"Prefer these over plain text or regex searches for code navigation.",
		].join("\n");
	}

	function buildProblemsReason(): string {
		return [
			"System Nudge: You have made several file modifications.",
			"Please use the `jetbrains_get_file_problems` tool to check the edited files for syntax errors or linting issues.",
			"This helps identify problems early and ensures the code remains valid.",
		].join("\n");
	}

	pi.on("session_start", (_event, ctx) => {
		resetSessionState();
		if (ctx.hasUI && isProxyOnlyMode()) {
			ctx.ui.notify(PROXY_RECONNECT_NOTIFY, "info");
		}
	});

	pi.on("turn_start", () => {
		resetRunState();
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PROXY_DISCOVERY_HINT}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as Record<string, unknown>)?.command ?? "");
			if (/\bmcp\s*\(\s*\{/.test(command)) {
				return {
					block: true,
					reason: "Detected mcp(...) executed via bash. Use the mcp tool directly, not shell syntax.",
				};
			}
		}

		const effectiveToolName = resolveEffectiveToolName(event as { toolName: string; input: Record<string, unknown> });

		if (effectiveToolName.endsWith("get_file_problems")) {
			writeStreak = 0;
		} else if (effectiveToolName === "write" || effectiveToolName === "edit") {
			writeStreak += 1;
			if (writeStreak >= THRESHOLD && canProblemsNudgeNow()) {
				writeStreak = 0;
				lastProblemsNudgeAt = Date.now();
				problemsNudgesSent += 1;

				if (ctx.hasUI) {
					ctx.ui.notify("🧭 Problems nudge: steering model to check edited files", "warning");
				}

				pi.sendUserMessage(buildProblemsReason(), { deliverAs: "steer" });
			}
		}

		if (isSymbolicTool(effectiveToolName)) {
			usedSymbolicThisRun = true;
			genericStreak = 0;
			return;
		}

		if (!isGenericTool(effectiveToolName)) return;

		genericStreak += 1;

		if (usedSymbolicThisRun) return;
		if (genericStreak < THRESHOLD) return;
		if (!canNudgeNow()) return;

		lastNudgeAt = Date.now();
		nudgesSent += 1;
		genericStreak = 0;

		if (ctx.hasUI) {
			ctx.ui.notify("🧭 Symbol nudge: steering model toward JetBrains symbol tools", "warning");
		}

		pi.sendUserMessage(buildReason(effectiveToolName), { deliverAs: "steer" });
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

		ctx.ui.notify(
			[
				"jetbrains-nudge: always-on (proxy mode aware)",
				`generic streak: ${genericStreak}/${THRESHOLD}`,
				`write streak: ${writeStreak}/${THRESHOLD}`,
				`used symbolic this run: ${usedSymbolicThisRun ? "yes" : "no"}`,
				`symbol nudges sent: ${nudgesSent}`,
				`problems nudges sent: ${problemsNudgesSent}`,
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
