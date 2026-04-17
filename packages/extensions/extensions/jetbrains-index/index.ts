import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatDiagnosticsSummary } from "./diagnostics.js";
import {
	buildMoveRefactorReminder,
	buildNewDiagnosticsReminder,
	buildReadEfficiencyReminder,
	buildSystemPromptPolicy,
	wrapSystemReminder,
} from "./prompts.js";
import {
	LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD,
	LARGE_READ_LINE_THRESHOLD,
	MOVE_BASH_REGEX,
	NON_SYMBOLIC_DENY_COOLDOWN_MS,
	NON_SYMBOLIC_STREAK_BLOCK_THRESHOLD,
	NON_SYMBOLIC_UNBOUNDED_READ_INCREMENT,
	NUDGE_COOLDOWN_MS,
	SEARCH_BASH_REGEX,
} from "./constants.js";
import { ProblemsTracker } from "./problems-tracker.js";

const SINGLETON_KEY = "__my_pi_jetbrains_index_owner__";

function getFilePathFromToolInput(input: Record<string, unknown>): string | null {
	const candidates = [input.path, input.file_path, input.filePath, input.file];
	for (const value of candidates) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return null;
}

function isUnboundedReadInput(input: Record<string, unknown>): boolean {
	const hasOffset = typeof input.offset === "number";
	const hasLimit = typeof input.limit === "number";
	return !hasOffset && !hasLimit;
}

function countTextLinesFromToolContent(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}

	let lines = 0;
	for (const block of content) {
		if (!(block && typeof block === "object")) {
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type !== "text") {
			continue;
		}
		const text = record.text;
		if (typeof text !== "string" || text.length === 0) {
			continue;
		}
		lines += text.split(/\r?\n/).length;
	}

	return lines;
}

function resolveEffectiveToolName(toolName: string, input: Record<string, unknown>): string {
	if (toolName !== "mcp") {
		return toolName;
	}

	const proxyTool = input.tool;
	if (typeof proxyTool === "string" && proxyTool.trim().length > 0) {
		return proxyTool.trim();
	}

	return toolName;
}

function isSearchFirstResetTool(toolName: string): boolean {
	return toolName.endsWith("ide_find_file")
		|| toolName.endsWith("ide_search_text")
		|| toolName.endsWith("ide_find_class")
		|| toolName.endsWith("ide_find_definition")
		|| toolName.endsWith("ide_find_references");
}

function isSemanticIdeTool(toolName: string): boolean {
	return toolName.endsWith("ide_find_file")
		|| toolName.endsWith("ide_search_text")
		|| toolName.endsWith("ide_find_class")
		|| toolName.endsWith("ide_find_definition")
		|| toolName.endsWith("ide_find_references")
		|| toolName.endsWith("ide_find_implementations")
		|| toolName.endsWith("ide_find_super_methods")
		|| toolName.endsWith("ide_type_hierarchy")
		|| toolName.endsWith("ide_call_hierarchy")
		|| toolName.endsWith("ide_refactor_rename")
		|| toolName.endsWith("ide_move_file")
		|| toolName.endsWith("ide_diagnostics");
}

function getBashCommand(input: Record<string, unknown>): string {
	const command = input.command;
	if (typeof command !== "string") {
		return "";
	}
	return command.trim();
}

function getNonSymbolicIncrement(toolName: string, input: Record<string, unknown>): number {
	if (toolName === "grep") {
		return 1;
	}

	if (toolName === "read") {
		return isUnboundedReadInput(input) ? NON_SYMBOLIC_UNBOUNDED_READ_INCREMENT : 1;
	}

	if (toolName === "bash") {
		const command = getBashCommand(input);
		if (command && SEARCH_BASH_REGEX.test(command)) {
			return 1;
		}
	}

	return 0;
}

function describeNonSymbolicTool(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "read") {
		return isUnboundedReadInput(input) ? "read (unbounded)" : "read";
	}

	if (toolName === "bash") {
		const command = getBashCommand(input);
		if (command && SEARCH_BASH_REGEX.test(command)) {
			return `bash (${toCommandPreview(command)})`;
		}
	}

	return toolName;
}

function isMoveCommand(command: string): boolean {
	return MOVE_BASH_REGEX.test(command);
}

function toCommandPreview(command: string): string {
	const normalized = command.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

// noinspection JSUnusedGlobalSymbols
export default function jetbrainsIndexExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as Record<string, unknown>;
	if (globalState[SINGLETON_KEY]) {
		return;
	}

	const ownerToken = Symbol("jetbrains-index-owner");
	globalState[SINGLETON_KEY] = ownerToken;

	let extensionEnabled = false;
	let uiNotify: ((message: string, level: "info" | "warning" | "error") => void) | null = null;
	let unboundedReadCountThisTurn = 0;
	let unboundedReadWarningSentThisTurn = false;
	let consecutiveLargeReadCountThisTurn = 0;
	let nearReadBlockWarningSentThisTurn = false;
	let nonSymbolicStreakCountThisTurn = 0;
	let lastNonSymbolicDenyAt = 0;
	let sessionStartNudgePending = false;
	let lastReadReminderAt = 0;
	let lastMoveReminderAt = 0;

	const tracker = new ProblemsTracker((message, level) => {
		uiNotify?.(message, level);
	});

	async function refreshExtensionEnabled(cwd: string): Promise<boolean> {
		try {
			const connected = await tracker.initialize(cwd);
			extensionEnabled = connected;
			if (!connected) {
				await tracker.shutdown();
			}
			return connected;
		} catch (error) {
			extensionEnabled = false;
			const message = error instanceof Error ? error.message : String(error);
			uiNotify?.(`JetBrains index diagnostics gate failed to initialize: ${message}`, "error");
			return false;
		}
	}

	function notifyIndexBlock(ctx: { hasUI: boolean; ui: { notify: (m: string, l: "info" | "warning" | "error") => void } }, reason: string): void {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify(`⛔ Edit/write blocked: ${reason}`, "error");
	}

	pi.on("session_start", async (_event, ctx) => {
		tracker.reset();
		unboundedReadCountThisTurn = 0;
		unboundedReadWarningSentThisTurn = false;
		consecutiveLargeReadCountThisTurn = 0;
		nearReadBlockWarningSentThisTurn = false;
		nonSymbolicStreakCountThisTurn = 0;
		if (ctx.hasUI) {
			uiNotify = ctx.ui.notify.bind(ctx.ui);
		}

		const connected = await refreshExtensionEnabled(ctx.cwd);
		sessionStartNudgePending = connected;
		if (!ctx.hasUI) {
			return;
		}

		if (connected) {
			ctx.ui.notify("🔍 JetBrains index diagnostics gate enabled", "info");
		} else {
			const disableReason = tracker.getStatus().lastError ?? "requirements not satisfied";
			ctx.ui.notify(`ℹ️ JetBrains index diagnostics gate disabled: ${disableReason}`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		await tracker.shutdown();
		extensionEnabled = false;
		sessionStartNudgePending = false;
		nonSymbolicStreakCountThisTurn = 0;
		uiNotify = null;

		if (globalState[SINGLETON_KEY] === ownerToken) {
			delete globalState[SINGLETON_KEY];
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		tracker.reset();
		unboundedReadCountThisTurn = 0;
		unboundedReadWarningSentThisTurn = false;
		consecutiveLargeReadCountThisTurn = 0;
		nearReadBlockWarningSentThisTurn = false;
		nonSymbolicStreakCountThisTurn = 0;
		await refreshExtensionEnabled(ctx.cwd);
	});

	pi.on("before_agent_start", (event) => {
		const reminders = [wrapSystemReminder(buildSystemPromptPolicy(pi.getActiveTools()))];
		if (extensionEnabled && sessionStartNudgePending) {
			sessionStartNudgePending = false;
			reminders.push(wrapSystemReminder([
				"JetBrains index is available in this session.",
				"- Prefer IDE semantic tools first before broad read/grep/bash exploration.",
				"- Start with jetbrains_index_ide_find_file, jetbrains_index_ide_search_text, jetbrains_index_ide_find_definition, and jetbrains_index_ide_find_references.",
				"- Keep reads focused with offset/limit windows.",
			].join("\n")));
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${reminders.join("\n\n")}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const effectiveToolName = resolveEffectiveToolName(event.toolName, input);

		if (isSearchFirstResetTool(effectiveToolName)) {
			consecutiveLargeReadCountThisTurn = 0;
			nearReadBlockWarningSentThisTurn = false;
		}

		if (
			effectiveToolName === "read"
			&& isUnboundedReadInput(input)
			&& consecutiveLargeReadCountThisTurn >= LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD
		) {
			const reason = `Blocked unbounded read after ${consecutiveLargeReadCountThisTurn} consecutive large reads (> ${LARGE_READ_LINE_THRESHOLD} lines). Use IDE search-first tools or switch to bounded read (offset/limit).`;
			consecutiveLargeReadCountThisTurn = 0;
			nearReadBlockWarningSentThisTurn = false;
			if (ctx.hasUI) {
				ctx.ui.notify(`⛔ ${reason}`, "error");
			}
			return {
				block: true,
				reason,
			};
		}

		if (!extensionEnabled) {
			return;
		}

		if (isSemanticIdeTool(effectiveToolName)) {
			nonSymbolicStreakCountThisTurn = 0;
		} else {
			const increment = getNonSymbolicIncrement(effectiveToolName, input);
			if (increment > 0) {
				const now = Date.now();
				const cooldownElapsed =
					lastNonSymbolicDenyAt === 0 || now - lastNonSymbolicDenyAt >= NON_SYMBOLIC_DENY_COOLDOWN_MS;
				if (cooldownElapsed) {
					nonSymbolicStreakCountThisTurn += increment;
					if (nonSymbolicStreakCountThisTurn >= NON_SYMBOLIC_STREAK_BLOCK_THRESHOLD) {
						const reason = `Blocked ${describeNonSymbolicTool(effectiveToolName, input)} after ${nonSymbolicStreakCountThisTurn} consecutive non-symbolic steps. Prefer JetBrains IDE index tools first (find_definition/find_references/find_file/search_text). Cooldown: ${Math.round(NON_SYMBOLIC_DENY_COOLDOWN_MS / 1000)}s.`;
						nonSymbolicStreakCountThisTurn = 0;
						lastNonSymbolicDenyAt = now;
						if (ctx.hasUI) {
							ctx.ui.notify(`⛔ ${reason}`, "warning");
						}
						return {
							block: true,
							reason,
						};
					}
				}
			}
		}

		if (event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}

		const filePath = getFilePathFromToolInput(input);
		if (!filePath) {
			if (ctx.hasUI) {
				ctx.ui.notify("⚠ Unable to determine edit/write target path for diagnostics gate.", "warning");
			}
			return;
		}

		const absolutePath = resolve(ctx.cwd, filePath);
		try {
			const beforeMutation = await tracker.beforeFileMutation(absolutePath);
			if (beforeMutation.allowed) {
				return;
			}

			const reason = beforeMutation.reason ?? "IDE index is not ready after retries.";
			notifyIndexBlock(ctx, reason);
			return {
				block: true,
				reason,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const reason = `Diagnostics preflight failed: ${message}`;
			notifyIndexBlock(ctx, reason);
			return {
				block: true,
				reason,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;

		if (event.toolName === "read" && !event.isError) {
			const unbounded = isUnboundedReadInput(input);
			const lineCount = countTextLinesFromToolContent(event.content);
			const isLargeRead = lineCount > LARGE_READ_LINE_THRESHOLD;

			if (!unbounded) {
				consecutiveLargeReadCountThisTurn = 0;
				nearReadBlockWarningSentThisTurn = false;
			} else if (isLargeRead) {
				consecutiveLargeReadCountThisTurn += 1;
			} else {
				consecutiveLargeReadCountThisTurn = 0;
				nearReadBlockWarningSentThisTurn = false;
			}

			if (unbounded) {
				unboundedReadCountThisTurn += 1;
				const reasons: string[] = [];

				if (isLargeRead) {
					reasons.push(
						`Large unbounded read detected (${lineCount} lines). Use search-first and bounded reads to minimize tokens.`,
					);
				}

				if (unboundedReadCountThisTurn >= 2 && !unboundedReadWarningSentThisTurn) {
					unboundedReadWarningSentThisTurn = true;
					reasons.push(
						`You already made ${unboundedReadCountThisTurn} unbounded reads this turn. Prefer bounded read windows (offset/limit).`,
					);
				}

				if (
					consecutiveLargeReadCountThisTurn === LARGE_READ_CONSECUTIVE_BLOCK_THRESHOLD - 1
					&& !nearReadBlockWarningSentThisTurn
				) {
					nearReadBlockWarningSentThisTurn = true;
					reasons.push(
						"Hard limit warning: one more consecutive large unbounded read will be blocked. Use search-first IDE tools or a bounded read first.",
					);
				}

				if (reasons.length > 0) {
					const now = Date.now();
					if (now - lastReadReminderAt >= NUDGE_COOLDOWN_MS) {
						lastReadReminderAt = now;
						if (ctx.hasUI) {
							ctx.ui.notify("⚠ Prefer search-first and bounded reads for token efficiency", "warning");
						}

						const reminder = buildReadEfficiencyReminder(pi.getActiveTools(), reasons);
						const baseContent = Array.isArray(event.content) ? event.content : [];
						return {
							content: [...baseContent, { type: "text", text: reminder }],
						};
					}
				}
			}
		}

		if (event.toolName === "bash" && !event.isError) {
			const command = getBashCommand(input);
			if (command && isMoveCommand(command)) {
				const now = Date.now();
				if (now - lastMoveReminderAt >= NUDGE_COOLDOWN_MS) {
					lastMoveReminderAt = now;
					if (ctx.hasUI) {
						ctx.ui.notify("⚠ Detected mv/git mv. Prefer IDE move refactor for code files", "warning");
					}

					const reminder = buildMoveRefactorReminder(pi.getActiveTools(), toCommandPreview(command));
					const baseContent = Array.isArray(event.content) ? event.content : [];
					return {
						content: [...baseContent, { type: "text", text: reminder }],
					};
				}
			}
		}

		if (!extensionEnabled) {
			return;
		}

		if (event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}

		const filePath = getFilePathFromToolInput(input);
		if (!filePath) {
			return;
		}

		const absolutePath = resolve(ctx.cwd, filePath);
		if (event.isError) {
			tracker.discardPending(absolutePath);
			return;
		}

		try {
			const newProblems = await tracker.getNewProblems([absolutePath]);
			if (newProblems.length === 0) {
				return;
			}

			const issueCount = newProblems.reduce((sum, file) => sum + file.diagnostics.length, 0);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`🔍 New JetBrains index diagnostics: ${issueCount} issue${issueCount === 1 ? "" : "s"}`,
					"warning",
				);
			}

			const summary = formatDiagnosticsSummary(newProblems);
			const reminder = buildNewDiagnosticsReminder(summary);
			const baseContent = Array.isArray(event.content) ? event.content : [];
			return {
				content: [...baseContent, { type: "text", text: reminder }],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`Failed to collect JetBrains index diagnostics: ${message}`, "error");
			}
		}
	});
}
