/**
 * semantic-search extension
 *
 * Provides the `semantic-search` tool for conceptual/semantic search over
 * the Vera-indexed codebase (hybrid BM25 + vector search).
 *
 * Vera must always run from the target directory (cd first), so all vera
 * invocations are wrapped in `bash -c 'cd <dir> && vera ...'`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_RESTARTS = 5;
const RESTART_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

// ─── Watcher state ──────────────────────────────────────────────────────

interface WatcherEntry {
	child: ChildProcess;
	cwd: string;
	restartCount: number;
	timer?: ReturnType<typeof setTimeout>;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
}

let currentWatcher: WatcherEntry | null = null;
let ensureCwdIndexPromise: Promise<{ ok: boolean; error?: string }> | null = null;
let shuttingDown = false;

// ─── Shell helpers ──────────────────────────────────────────────────────

/** Single-quote shell-escape: `'text'` with embedded single quotes escaped. */
function sq(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build a `cd <dir> && vera <args...>` bash command string. */
function veraCommand(targetDir: string, args: string[]): string {
	const shellCmd = ["vera", ...args].map(sq).join(" ");
	return `cd ${sq(targetDir)} && ${shellCmd}`;
}

/**
 * Run vera in the target directory and return the result.
 * Always wraps in `bash -c 'cd <dir> && vera ...'` because vera resolves
 * .vera, .veraignore, and .gitignore from its literal CWD.
 */
function runVera(
	targetDir: string,
	args: string[],
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const bashCmd = veraCommand(targetDir, args);
		const child = spawn("bash", ["-c", bashCmd], {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			resolvePromise({ stdout, stderr, code });
		});

		if (timeoutMs && timeoutMs > 0) {
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGTERM");
				resolvePromise({ stdout, stderr, code: null });
			}, timeoutMs);
			// Clean up timer if process finishes first
			child.on("close", () => clearTimeout(timer));
		}
	});
}

// ─── Preflight check ───────────────────────────────────────────────────

/**
 * Fire-and-forget check that vera is available on PATH.
 * Notifies the user via TUI if missing.
 */
function preflightVeraAvailable(
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): void {
	const child = spawn("bash", ["-c", "command -v vera"], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	const warn = () =>
		notify("⚠ Vera binary not found on PATH. Install vera to enable semantic search.", "warning");
	child.on("error", warn);
	child.on("close", (code) => {
		if (code !== 0) warn();
	});
}

// ─── Watcher management ─────────────────────────────────────────────────

function stopWatcher(enterShutdown = true): void {
	shuttingDown = enterShutdown;
	const w = currentWatcher;
	currentWatcher = null;
	if (!w) return;
	if (w.timer) clearTimeout(w.timer);
	if (!w.child.killed) {
		w.child.kill("SIGTERM");
	}
}

/**
 * Start a `vera watch .` process for the given target directory.
 * Only meaningful for ctx.cwd (the active workspace).
 */
function spawnWatcher(
	targetDir: string,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
	restartCount = 0,
): void {
	if (shuttingDown) return;
	// Don't start if already watching this directory with a live process
	if (currentWatcher && currentWatcher.cwd === targetDir && !currentWatcher.child.killed) {
		return;
	}

	stopWatcher(false);

	const bashCmd = veraCommand(targetDir, ["watch", "."]);
	const child = spawn("bash", ["-c", bashCmd], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stderrAcc = "";

	child.stderr?.on("data", (d: Buffer) => {
		stderrAcc += d.toString();
	});

	const entry: WatcherEntry = {
		child,
		cwd: targetDir,
		restartCount: restartCount,
		notify,
	};

	currentWatcher = entry;

	child.on("exit", (code, _signal) => {
		// If the watcher was replaced or stopped, don't restart
		if (currentWatcher?.child !== child) return;

		const w = currentWatcher;
		const tail = stderrAcc.slice(-600);

		// Clean exit (code 0) or signal termination (null) — no restart
		if (code === 0 || code === null) {
			currentWatcher = null;
			return;
		}

		// Only restart on actual failures (non-zero exit)
		if (w.restartCount < MAX_RESTARTS) {
			const nextRestartCount = w.restartCount + 1;
			const delay = RESTART_DELAYS_MS[w.restartCount] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
			w.restartCount = nextRestartCount;
			w.notify(
				`⚠ Vera watch exited (code ${code}). Restart ${nextRestartCount}/${MAX_RESTARTS} in ${delay / 1000}s.`,
				"warning",
			);
			if (tail) {
				w.notify(`Vera watch stderr: ${tail}`, "warning");
			}
			w.timer = setTimeout(() => {
				spawnWatcher(targetDir, notify, nextRestartCount);
			}, delay);
		} else {
			if (tail) {
				w.notify(`Vera watch stderr: ${tail}`, "error");
			}
			w.notify(
				"Vera watch failed after retries. Run `vera watch .` manually to re-enable live indexing.",
				"error",
			);
			currentWatcher = null;
		}
	});
}

function startWatcherForCwd(cwd: string, ctx: ExtensionContext): void {
	shuttingDown = false;
	if (!existsSync(resolve(cwd, ".vera"))) return;
	const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
	spawnWatcher(cwd, notify);
}

async function ensureCurrentWorkspaceIndexed(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	if (existsSync(resolve(ctx.cwd, ".vera"))) {
		return { ok: true, created: false };
	}

	const startedIndexing = !ensureCwdIndexPromise;
	if (startedIndexing) {
		if (ctx.hasUI) {
			ctx.ui.notify("🔍 No Vera index found in current workspace. Generating one-time index...", "info");
		}
		ensureCwdIndexPromise = runVera(ctx.cwd, ["index", "."], signal, 300_000)
			.then((idxResult) => {
				if (idxResult.code !== 0) {
					return {
						ok: false,
						error: idxResult.stderr || `vera index exited with code ${idxResult.code}`,
					};
				}
				return { ok: true };
			})
			.catch((error: unknown) => ({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}))
			.finally(() => {
				ensureCwdIndexPromise = null;
			});
	}

	const promise = ensureCwdIndexPromise;
	if (!promise) {
		return { ok: false, created: false, error: "Vera index initialization was not started." };
	}

	const result = await promise;
	return { ok: result.ok, created: startedIndexing && result.ok, error: result.error };
}

// ─── Tool parameter schema ──────────────────────────────────────────────

const SemanticSearchParams = Type.Object({
	query: Type.String({
		description:
			'Search intent, e.g. "dashboard controller", "routing config", "error handling".',
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Target repository root directory. Relative paths resolve against current working directory. Defaults to current workspace if omitted. The target directory must have its own .vera index; to narrow within the current repo, use path instead.",
		}),
	),
	lang: Type.Optional(
		Type.String({
			description:
				"Optional language filter (examples: \"typescript\", \"rust\", \"python\", \"markdown\"); omitted searches all languages.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				'Optional path glob filter (examples: "src/**", "docs/**"); omitted searches all paths. Supports * and ** patterns.',
		}),
	),
	type: Type.Optional(
		StringEnum(
			[
				"function",
				"method",
				"class",
				"struct",
				"enum",
				"trait",
				"interface",
				"type_alias",
				"constant",
				"variable",
				"module",
				"block",
			] as const,
			{ description: "Optional symbol-type filter; omitted searches all types." },
		) as any,
	),
	scope: Type.Optional(
		StringEnum(
			["source", "docs", "runtime", "all"] as const,
			{
				description:
					"Corpus scope filter: source (code), docs (prose), runtime, or all.",
			},
		) as any,
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Max number of results to return (1..100)",
			minimum: 1,
			maximum: 100,
			default: 5,
		}),
	),
});

// ─── Extension entry ────────────────────────────────────────────────────

export default function semanticSearchExtension(pi: ExtensionAPI): void {
	// ── Lifecycle: start watcher on session start (if .vera exists) ─────
	pi.on("session_start", (_event, ctx) => {
		const notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : () => {};
		preflightVeraAvailable(notify);
		startWatcherForCwd(ctx.cwd, ctx);
	});

	// ── Lifecycle: clean up watcher on shutdown ─────────────────────────
	pi.on("session_shutdown", () => {
		stopWatcher();
	});

	// ── Tool registration ───────────────────────────────────────────────
	pi.registerTool({
		name: "semantic-search",
		label: "Semantic Search",
		description:
			"Semantic and conceptual search over the indexed codebase using Vera (hybrid BM25 + vector search).\n\n"
			+ "Use this to discover code, docs, or runtime behavior by intent/concept when you don't know exact file names, "
			+ "symbol names, or locations. For exact symbol lookup, references, callers, renaming, or filename search, "
			+ "use the dedicated IDE tools or grep instead.\n\n"
			+ "Supports filtering by language, file path glob, symbol type, and corpus scope. "
			+ "Use `path` to narrow within the current indexed repo. Use `cwd` only to target a different repo root, which must have its own `.vera` index.\n\n",
		promptSnippet:
			"Semantic/conceptual search across the repo. Use to find code, docs, or runtime behavior by intent — not for exact symbol/file/reference lookup.",
		promptGuidelines: [
			"Use semantic-search for conceptual discovery when you don't know exact names or locations.",
			"Do NOT use semantic-search for exact symbol lookup, finding references, finding callers/callees, renaming, or filename search — use IDE tools (ide_find_symbol, ide_find_references, ide_call_hierarchy, ide_rename_symbol, ide_find_file) or grep for those.",
			"After semantic-search finds candidate files, switch to read, ide_file_structure, or ide_find_references for exact follow-up.",
		],
		parameters: SemanticSearchParams as any,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const query = p.query as string;
			if (!query || typeof query !== "string" || !query.trim()) {
				return {
					content: [{ type: "text" as const, text: "Error: query is required." }],
					isError: true,
					details: {},
				};
			}

			// ── Resolve target directory ────────────────────────────────
			const cwd = ctx.cwd;
			let targetDir = cwd;
			if (typeof p.cwd === "string" && p.cwd.trim()) {
				targetDir = isAbsolute(p.cwd) ? p.cwd : resolve(cwd, p.cwd);
			}

			// ── Check target directory exists ──────────────────────────
			if (!existsSync(targetDir)) {
				return {
					content: [{ type: "text" as const, text: `Directory does not exist: ${targetDir}` }],
					isError: true,
					details: {},
				};
			}

			// ── Auto-index for current workspace only ──────────────────
			if (!existsSync(resolve(targetDir, ".vera"))) {
				if (targetDir === cwd) {
					const indexResult = await ensureCurrentWorkspaceIndexed(ctx, signal);
					if (!indexResult.ok) {
						return {
							content: [{ type: "text" as const, text: `Failed to create Vera index: ${indexResult.error}` }],
							isError: true,
							details: {},
						};
					}
					if (indexResult.created && ctx.hasUI) {
						ctx.ui.notify(
							"✅ Vera index generated. Tune .veraignore and re-run `vera index .` to adjust what's indexed.",
							"info",
						);
					}
					// Start watcher after successful index
					startWatcherForCwd(cwd, ctx);
				} else {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`No Vera index found at ${targetDir}/.vera. `
									+ `Run \`vera index ${targetDir}\` first, or choose a different target directory.`,
							},
						],
						isError: true,
						details: {},
					};
				}
			}

			// ── Build search args ───────────────────────────────────────
			const args: string[] = ["search", query];
			if (typeof p.lang === "string" && p.lang.trim()) args.push("--lang", p.lang.trim());
			if (typeof p.path === "string" && p.path.trim()) args.push("--path", p.path.trim());
			if (typeof p.type === "string" && p.type.trim()) args.push("--type", p.type.trim());
			if (typeof p.scope === "string" && p.scope.trim()) args.push("--scope", p.scope.trim());
			const limit = typeof p.limit === "number" ? Math.max(1, Math.min(100, p.limit)) : 5;
			args.push("--limit", String(limit));

			// ── Run search ──────────────────────────────────────────────
			let result: Awaited<ReturnType<typeof runVera>>;
			try {
				result = await runVera(targetDir, args, signal, 60_000);
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: {},
				};
			}

			if (result.code !== 0) {
				const msg = result.stderr || `exit code ${result.code}`;
				return {
					content: [{ type: "text" as const, text: `Vera search failed: ${msg}` }],
					isError: true,
					details: {},
				};
			}

			const output = result.stdout.trim();
			if (!output) {
				return {
					content: [{ type: "text" as const, text: "No results found." }],
					details: {},
				};
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details: {},
			};
		},
	});
}
