import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── config ─────────────────────────────────────────────────────────────

const MAX_CHARS = 10_000; // ~2,500 tokens
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ─── temp file helpers ──────────────────────────────────────────────────

const TMP_DIR = join(homedir(), ".pi", "agent", "tmp");

function ensureTmpDir(): string {
	if (!existsSync(TMP_DIR)) {
		mkdirSync(TMP_DIR, { recursive: true });
	}
	return TMP_DIR;
}

/** Extract a short session prefix from the session file path for naming + cleanup. */
function sessionPrefix(ctx: ExtensionContext | undefined): string {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		if (!file) return "unknown";
		// Take last part of filename, strip extension, limit to 8 chars
		const base = file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "unknown";
		return base.slice(0, 8);
	} catch {
		return "unknown";
	}
}

function generateFilePath(ctx: ExtensionContext | undefined): string {
	const dir = ensureTmpDir();
	const prefix = sessionPrefix(ctx);
	const id = randomBytes(4).toString("hex");
	return join(dir, `${prefix}-${id}.txt`);
}

function saveToFile(content: string, ctx: ExtensionContext | undefined): string {
	const filePath = generateFilePath(ctx);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/** Delete all files in TMP_DIR older than MAX_AGE_MS. */
function cleanupStaleFiles(): void {
	if (!existsSync(TMP_DIR)) return;
	const now = Date.now();
	try {
		for (const entry of readdirSync(TMP_DIR)) {
			const fullPath = join(TMP_DIR, entry);
			try {
				const stat = statSync(fullPath);
				if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
					unlinkSync(fullPath);
				}
			} catch {
				// File may have been deleted between readdir and stat — skip
			}
		}
	} catch {
		// TMP_DIR may have been removed — skip
	}
}

/** Delete files belonging to this session (matching session prefix). */
function cleanupSessionFiles(ctx: ExtensionContext | undefined): void {
	if (!existsSync(TMP_DIR)) return;
	const prefix = sessionPrefix(ctx);
	try {
		for (const entry of readdirSync(TMP_DIR)) {
			if (entry.startsWith(prefix + "-")) {
				try {
					unlinkSync(join(TMP_DIR, entry));
				} catch {
					// Skip
				}
			}
		}
	} catch {
		// Skip
	}
}

// ─── token estimation ───────────────────────────────────────────────────

function estimateTokens(charCount: number): number {
	return Math.ceil(charCount / 4);
}

// ─── extension ──────────────────────────────────────────────────────────

export default function outputCapExtension(pi: ExtensionAPI): void {
	// ─── TOOL RESULT HOOK ─────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// Extract text content
		const textParts: string[] = [];
		for (const part of event.content) {
			if (part.type === "text") {
				textParts.push(part.text);
			}
		}
		const text = textParts.join("");

		if (text.length <= MAX_CHARS) return;

		// Determine where the full output lives:
		// 1. Pi may have already saved full output to a temp file (details.fullOutputPath)
		// 2. Otherwise, we save it ourselves
		const details = event.details as Record<string, unknown> | undefined;
		const piTempFile = (details?.fullOutputPath as string | undefined) ?? undefined;

		let savedPath: string;
		if (piTempFile && existsSync(piTempFile)) {
			// Pi already saved the full output — reference it directly
			savedPath = piTempFile;
		} else {
			// Save the truncated output we received (which is already Pi-truncated to 50KB)
			// This is still larger than our cap, so it's useful
			savedPath = saveToFile(text, ctx);
		}

		const estTokens = estimateTokens(text.length);
		const capTokens = estimateTokens(MAX_CHARS);

		const notice =
			`⛔ Output capped: ${text.length.toLocaleString()} chars (~${estTokens.toLocaleString()} tokens) ` +
			`exceeds ${MAX_CHARS.toLocaleString()} char limit (~${capTokens.toLocaleString()} tokens).\n` +
			`Full output saved to: ${savedPath}\n` +
			`Use \`head -50 ${savedPath}\` or \`grep <pattern> ${savedPath}\` to inspect.`;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`⛔ ${event.toolName} output capped: ${text.length.toLocaleString()} chars → saved to temp file`,
				"warning",
			);
		}

		return {
			content: [{ type: "text" as const, text: notice }],
		};
	});

	// ─── CLEANUP ON STARTUP ───────────────────────────────────────────
	pi.on("session_start", async () => {
		cleanupStaleFiles();
	});

	// ─── CLEANUP ON SHUTDOWN ──────────────────────────────────────────
	pi.on("session_shutdown", async (_event, ctx) => {
		cleanupSessionFiles(ctx);
	});
}
