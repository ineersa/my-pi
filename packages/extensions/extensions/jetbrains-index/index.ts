import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatDiagnosticsSummary } from "./diagnostics.js";
import {
	buildNewDiagnosticsReminder,
	buildSystemPromptPolicy,
	wrapSystemReminder,
} from "./prompts.js";
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

function resolveActiveToolName(activeTools: string[], candidates: string[]): string {
	const activeSet = new Set(activeTools);
	for (const candidate of candidates) {
		if (activeSet.has(candidate)) {
			return candidate;
		}
	}

	for (const candidate of candidates) {
		const match = activeTools.find((name) => name.endsWith(`_${candidate}`));
		if (match) {
			return match;
		}
	}

	return "(not active)";
}

function buildReadEfficiencyReminderText(activeTools: string[], reasons: string[]): string {
	const findFile = resolveActiveToolName(activeTools, [
		"jetbrains_index_ide_find_file",
		"ide_find_file",
	]);
	const searchText = resolveActiveToolName(activeTools, [
		"jetbrains_index_ide_search_text",
		"ide_search_text",
	]);

	return wrapSystemReminder([
		"Token Efficiency Reminder:",
		...reasons.map((reason) => `- ${reason}`),
		`- Use ${findFile} and ${searchText} to locate targets before reading full files.`,
		"- Prefer bounded read windows (offset/limit) over unbounded full-file reads.",
	].join("\n"));
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
		if (ctx.hasUI) {
			uiNotify = ctx.ui.notify.bind(ctx.ui);
		}

		const connected = await refreshExtensionEnabled(ctx.cwd);
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
		uiNotify = null;

		if (globalState[SINGLETON_KEY] === ownerToken) {
			delete globalState[SINGLETON_KEY];
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		tracker.reset();
		unboundedReadCountThisTurn = 0;
		unboundedReadWarningSentThisTurn = false;
		await refreshExtensionEnabled(ctx.cwd);
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${wrapSystemReminder(buildSystemPromptPolicy(pi.getActiveTools()))}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!extensionEnabled) {
			return;
		}

		if (event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}

		const input = (event.input ?? {}) as Record<string, unknown>;
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

		if (event.toolName === "read" && !event.isError && isUnboundedReadInput(input)) {
			unboundedReadCountThisTurn += 1;
			const lineCount = countTextLinesFromToolContent(event.content);
			const reasons: string[] = [];

			if (lineCount > 300) {
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

			if (reasons.length > 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("⚠ Prefer search-first and bounded reads for token efficiency", "warning");
				}

				const reminder = buildReadEfficiencyReminderText(pi.getActiveTools(), reasons);
				const baseContent = Array.isArray(event.content) ? event.content : [];
				return {
					content: [...baseContent, { type: "text", text: reminder }],
				};
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
