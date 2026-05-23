import { isAbsolute, relative, resolve } from "node:path";
import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDiagnosticsSummary } from "./diagnostics.js";
import {
	buildMoveRefactorReminder,
	buildNewDiagnosticsMessage,
} from "./prompts.js";
import {
	MOVE_BASH_REGEX,
	NUDGE_COOLDOWN_MS,
} from "./constants.js";
import { ProblemsTracker } from "./problems-tracker.js";
import { createAllWrapperTools } from "./wrappers.js";

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

function getBashCommand(input: Record<string, unknown>): string {
	const command = input.command;
	if (typeof command !== "string") {
		return "";
	}
	return command.trim();
}

function isMoveCommand(command: string): boolean {
	return MOVE_BASH_REGEX.test(command);
}

function toCommandPreview(command: string): string {
	const normalized = command.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

/**
 * Check whether a bash command is an mv/git mv that targets a file inside cwd.
 * Conservative: avoids false positives over catching every shell shape.
 */
function isMoveInsideCwd(command: string, cwd: string): boolean {
	const trimmed = command.trim();
	if (!MOVE_BASH_REGEX.test(trimmed)) return false;

	// Strip the command prefix (mv or git mv)
	const withoutCommand = trimmed.replace(/^(?:git\s+)?mv\s+/, "");
	const args = withoutCommand.split(/\s+/).filter((a) => a && !a.startsWith("-"));

	for (const arg of args) {
		try {
			const resolved = resolve(cwd, arg);
			const rel = relative(cwd, resolved);
			if (!rel.startsWith("..") && !isAbsolute(rel)) {
				return true;
			}
		} catch {
			// skip
		}
	}

	return false;
}

// noinspection JSUnusedGlobalSymbols
export default function jetbrainsIndexExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as Record<string, unknown>;
	if (globalState[SINGLETON_KEY]) {
		return;
	}

	const ownerToken = Symbol("jetbrains-index-owner");
	globalState[SINGLETON_KEY] = ownerToken;

	let extensionActive = false;
	let uiNotify: ((message: string, level: "info" | "warning" | "error") => void) | null = null;
	let lastMoveReminderAt = 0;
	let toolsRegistered = false;

	const tracker = new ProblemsTracker((message, level) => {
		uiNotify?.(message, level);
	});

	function hasIdeaDirectory(cwd: string): boolean {
		try {
			return statSync(resolve(cwd, ".idea")).isDirectory();
		} catch {
			return false;
		}
	}

	async function tryActivateForCwd(cwd: string): Promise<boolean> {
		if (!hasIdeaDirectory(cwd)) {
			extensionActive = false;
			await tracker.shutdown();
			return false;
		}
		try {
			const connected = await tracker.initialize(cwd);
			extensionActive = connected;
			if (!connected) {
				await tracker.shutdown();
			}
			return connected;
		} catch {
			extensionActive = false;
			// Silent failure — stay dormant
			return false;
		}
	}

	async function checkOrAbort(ctx: {
		hasUI: boolean;
		ui: { notify: (m: string, l: "info" | "warning" | "error") => void };
		abort: () => void;
	}, toolName: string): Promise<boolean> {
		// Returns true if safe to proceed, false if blocked
		const readiness = await tracker.checkIndexReady();
		if (readiness.ready) {
			return true;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`⛔ JetBrains IDE/index unavailable for tool "${toolName}". Fix your IDE/index and type "continue" to retry.`,
				"error",
			);
		}

		// Block the tool call and abort the current agent run
		ctx.abort();

		return false;
	}

	pi.on("session_start", async (_event, ctx) => {
		tracker.reset();
		if (ctx.hasUI) {
			uiNotify = ctx.ui.notify.bind(ctx.ui);
		}

		const activated = await tryActivateForCwd(ctx.cwd);
		if (!activated) {
			// Stay dormant — no prompt injection, no guards, no tools
			return;
		}

		// Perform initial whole-project sync
		await tracker.syncProject();

		// Register first-class wrapper tools if not already registered
		if (!toolsRegistered) {
			const client = tracker.getClient();
			if (client) {
				const wrapperTools = createAllWrapperTools(client);
				for (const tool of wrapperTools) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					pi.registerTool(tool as any);
				}
				toolsRegistered = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`🔍 JetBrains index active — ${wrapperTools.length} IDE tool(s) registered`,
						"info",
					);
				}
			}
		}

		if (ctx.hasUI && !toolsRegistered) {
			ctx.ui.notify("🔍 JetBrains index diagnostics gate enabled", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		await tracker.shutdown();
		extensionActive = false;
		uiNotify = null;

		if (globalState[SINGLETON_KEY] === ownerToken) {
			delete globalState[SINGLETON_KEY];
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!extensionActive) {
			// Attempt activation if not yet active (IDE may have become available)
			const activated = await tryActivateForCwd(ctx.cwd);
			if (!activated) {
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify("🔍 JetBrains index diagnostics gate enabled", "info");
			}
		}

		// Check index and sync the whole project at turn start
		const readiness = await tracker.checkIndexReady();
		if (readiness.ready) {
			await tracker.syncProject();
		} else {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`JetBrains IDE/index not ready at turn start: ${readiness.message ?? "unknown reason"}. Will recheck before each tool call.`,
					"warning",
				);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!extensionActive) {
			return;
		}

		const input = (event.input ?? {}) as Record<string, unknown>;

		// Health check before ANY tool call
		const canProceed = await checkOrAbort(ctx, event.toolName);
		if (!canProceed) {
			return { block: true, reason: "JetBrains IDE/index unavailable. Fix and type continue." };
		}

		// For edit/write: pre-mutation baseline capture
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
			if (ctx.hasUI) {
				ctx.ui.notify(`⛔ Edit/write blocked: ${reason}`, "error");
			}
			ctx.abort();
			return {
				block: true,
				reason,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`Diagnostics preflight failed: ${message}`, "error");
			}
			ctx.abort();
			return {
				block: true,
				reason: `Diagnostics preflight failed: ${message}`,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!extensionActive) {
			return;
		}

		const input = (event.input ?? {}) as Record<string, unknown>;

		// Narrowed mv/git mv handling — only when target is inside cwd
		if (event.toolName === "bash" && !event.isError) {
			const command = getBashCommand(input);
			if (command && isMoveCommand(command) && isMoveInsideCwd(command, ctx.cwd)) {
				try {
					const synced = await tracker.syncProject();
					if (!synced && ctx.hasUI) {
						ctx.ui.notify("⚠ Failed to sync IDE index after mv/git mv", "warning");
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) {
						ctx.ui.notify(`⚠ Failed to sync IDE index after mv/git mv: ${message}`, "warning");
					}
				}

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

		// Post-write diagnostics flow
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
			const message = buildNewDiagnosticsMessage(summary);
			const baseContent = Array.isArray(event.content) ? event.content : [];
			return {
				content: [...baseContent, { type: "text", text: message }],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`Failed to collect JetBrains index diagnostics: ${message}`, "error");
			}
		}
	});
}
