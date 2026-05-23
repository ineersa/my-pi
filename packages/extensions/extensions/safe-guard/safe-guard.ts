import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { classifyBash } from "./classify";
import { existsSync } from "node:fs";
import {
	loadPolicy,
	policyFilePath,
	globalPolicyFilePath,
	getDefaultProtectedReadPatterns,
	isCommandAllowed,
	isPathInList,
	isProtectedReadPath,
	addCommandAllow,
	addWritePathAllow,
	addProtectedReadPattern,
	removeProtectedReadPattern,
} from "./policy";

// ─── helpers ────────────────────────────────────────────────────────────

function isInsideCwd(cwd: string, targetPath: string): boolean {
	const resolved = resolve(cwd, targetPath);
	const normalizedCwd = resolve(cwd);
	return resolved === normalizedCwd || resolved.startsWith(normalizedCwd + "/");
}

function truncateCmd(cmd: string, max = 120): string {
	return cmd.length > max ? cmd.substring(0, max) + "…" : cmd;
}

// ─── extension ──────────────────────────────────────────────────────────

export default function safeGuardExtension(pi: ExtensionAPI): void {
	// ─── BASH TOOL ─────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command: string = event.input.command ?? "";
		const policy = loadPolicy(ctx.cwd);

		// Check allowlist first
		if (isCommandAllowed(policy, command)) return;

		const classification = classifyBash(command, policy.dangerousCommandPatterns);
		if (classification.kind === "allow") return;

		// Hard block: sudo — never negotiable
		if (classification.kind === "block") {
			if (ctx.hasUI) {
				ctx.ui.notify(`🚫 ${classification.reason}: ${truncateCmd(command)}`, "error");
			}
			return { block: true, reason: classification.reason };
		}

		// Non-interactive → block
		if (!ctx.hasUI) {
			return { block: true, reason: `${classification.reason} (non-interactive)` };
		}

		// Interactive → ask with allowlist option
		const options = ["❌ Block", "✅ Allow once", "📌 Always allow this command"] as const;
		const choice = await ctx.ui.select(
			`⚠️ ${classification.reason}: ${truncateCmd(command)}`,
			[...options],
		);

		if (!choice || choice === "❌ Block") {
			return { block: true, reason: `Blocked by user: ${classification.reason}` };
		}

		if (choice === "📌 Always allow this command") {
			addCommandAllow(ctx.cwd, command.trim());
			ctx.ui.notify(`✅ Allowlisted: ${truncateCmd(command)}`, "info");
		}
		// "✅ Allow once" → fall through, tool executes
	});

	// ─── WRITE / EDIT TOOLS ────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		const isWrite = isToolCallEventType("write", event);
		const isEdit = isToolCallEventType("edit", event);
		if (!isWrite && !isEdit) return;

		const rawPath: string = (event.input.path ?? "").replace(/^@/, "");
		if (!rawPath) return;

		// Inside CWD → always allowed
		if (isInsideCwd(ctx.cwd, rawPath)) return;

		const absPath = resolve(ctx.cwd, rawPath);
		const policy = loadPolicy(ctx.cwd);

		// Check path allowlist
		if (isPathInList(policy.allowWriteOutsideCwd, absPath)) return;

		// Non-interactive → block
		if (!ctx.hasUI) {
			return { block: true, reason: `Write outside CWD blocked (non-interactive): ${absPath}` };
		}

		// Interactive → ask
		const options = ["❌ Block", "✅ Allow once", "📌 Always allow this path"] as const;
		const choice = await ctx.ui.select(
			`⚠️ Write outside working directory: ${absPath}`,
			[...options],
		);

		if (!choice || choice === "❌ Block") {
			return { block: true, reason: `Blocked write outside CWD: ${absPath}` };
		}

		if (choice === "📌 Always allow this path") {
			addWritePathAllow(ctx.cwd, absPath);
			ctx.ui.notify(`✅ Path allowlisted: ${absPath}`, "info");
		}
	});

	// ─── READ TOOL ─────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const rawPath: string = (event.input.path ?? "").replace(/^@/, "");
		if (!rawPath) return;

		const policy = loadPolicy(ctx.cwd);

		if (!isProtectedReadPath(policy, rawPath)) return;

		const absPath = resolve(ctx.cwd, rawPath);

		// Non-interactive → block
		if (!ctx.hasUI) {
			return { block: true, reason: `Protected read path (non-interactive): ${absPath}` };
		}

		// Interactive → ask
		const options = [
			"❌ Block",
			"✅ Allow once",
			"📌 Always allow reading this file",
		] as const;
		const choice = await ctx.ui.select(
			`⚠️ Protected file — may contain secrets: ${absPath}`,
			[...options],
		);

		if (!choice || choice === "❌ Block") {
			return { block: true, reason: `Blocked read of protected path: ${absPath}` };
		}

		if (choice === "📌 Always allow reading this file") {
			addWritePathAllow(ctx.cwd, absPath);
			ctx.ui.notify(`✅ Read allowlisted: ${absPath}`, "info");
		}
		// "✅ Allow once" → fall through
	});

	// ─── COMMANDS ──────────────────────────────────────────────────────
	pi.registerCommand("safe-guard", {
		description: "Show safe-guard policy and current allowlists",
		handler: async (_args, ctx) => {
			const localPath = policyFilePath(ctx.cwd);
			const globalPath = globalPolicyFilePath();
			const hasLocal = existsSync(localPath);
			const hasGlobal = existsSync(globalPath);
			const policy = loadPolicy(ctx.cwd);
			const defaults = getDefaultProtectedReadPatterns();

			const activeFile = hasLocal ? localPath : hasGlobal ? globalPath : "(none — using defaults)";

			const lines = [
				`Policy file: ${activeFile}`,
				``,
				`Allowed commands (${policy.allowCommandPatterns.length}):`,
				...(policy.allowCommandPatterns.length
					? policy.allowCommandPatterns.map((p) => `  • ${p}`)
					: ["  (none)"]),
				``,
				`Allowed write paths outside CWD (${policy.allowWriteOutsideCwd.length}):`,
				...(policy.allowWriteOutsideCwd.length
					? policy.allowWriteOutsideCwd.map((p) => `  • ${p}`)
					: ["  (none)"]),
				``,
				`Protected read patterns (${policy.protectedReadPatterns.length}):`,
				...policy.protectedReadPatterns.map((p) => {
					const isDefault = defaults.includes(p);
					return `  • ${p}${isDefault ? "" : " (custom)"}`;
				}),
				``,
				`Custom dangerous patterns (${policy.dangerousCommandPatterns.length}):`,
				...(policy.dangerousCommandPatterns.length
					? policy.dangerousCommandPatterns.map((p) => `  • ${p}`)
					: ["  (none)"]),
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("safe-guard-allow-command", {
		description: "Add a command pattern to the persistent allowlist",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /safe-guard-allow-command <command pattern>", "warning");
				return;
			}
			addCommandAllow(ctx.cwd, args.trim());
			ctx.ui.notify(`✅ Allowlisted command: ${args.trim()}`, "info");
		},
	});

	pi.registerCommand("safe-guard-allow-path", {
		description: "Add a path to the write-outside-cwd persistent allowlist",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /safe-guard-allow-path <path>", "warning");
				return;
			}
			const absPath = resolve(ctx.cwd, args.trim());
			addWritePathAllow(ctx.cwd, absPath);
			ctx.ui.notify(`✅ Allowlisted path: ${absPath}`, "info");
		},
	});

	pi.registerCommand("safe-guard-protect-read", {
		description: "Add a filename/path pattern to the protected-read list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /safe-guard-protect-read <pattern>", "warning");
				return;
			}
			addProtectedReadPattern(ctx.cwd, args.trim());
			ctx.ui.notify(`🔒 Protected read pattern added: ${args.trim()}`, "info");
		},
	});

	pi.registerCommand("safe-guard-unprotect-read", {
		description: "Remove a filename/path pattern from the protected-read list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /safe-guard-unprotect-read <pattern>", "warning");
				return;
			}
			removeProtectedReadPattern(ctx.cwd, args.trim());
			ctx.ui.notify(`🔓 Removed protected read pattern: ${args.trim()}`, "info");
		},
	});
}
