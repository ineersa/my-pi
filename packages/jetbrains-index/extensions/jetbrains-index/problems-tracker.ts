import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { areDiagnosticsEqual, type Diagnostic, type DiagnosticFile } from "./diagnostics.js";
import { loadJetBrainsConfig } from "./settings-config.js";
import { JetBrainsService } from "./jetbrains-service.js";
import { prepareFileForDiagnostics } from "./diagnostics-protocol.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProblemsTrackerStatus = {
	initialized: boolean;
	connected: boolean;
	configPath?: string;
	lastError?: string;
};

export function formatProblemsTrackerStatus(status: ProblemsTrackerStatus): string {
	if (!status.initialized) {
		return status.lastError
			? `problems tracker: unavailable (${status.lastError})`
			: "problems tracker: unavailable";
	}

	if (!status.connected) {
		return `problems tracker: disconnected (config: ${status.configPath ?? "unknown"})`;
	}

	return `problems tracker: connected (config: ${status.configPath ?? "unknown"})`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePathForComparison(filePath: string): string {
	const resolved = resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toProjectRelativePath(projectPath: string, filePath: string): string | null {
	const absProjectPath = resolve(projectPath);
	const absFilePath = resolve(filePath);
	const rel = relative(absProjectPath, absFilePath);
	if (!rel || rel === "") {
		return null;
	}
	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		return null;
	}
	return rel.split(sep).join("/");
}

function hasIdeaDirectory(cwd: string): boolean {
	const ideaPath = resolve(cwd, ".idea");
	try {
		return statSync(ideaPath).isDirectory();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotifyFn = (message: string, level: "info" | "warning" | "error") => void;

type BeforeMutationResult = {
	allowed: boolean;
	reason?: string;
};

type PendingMutationContext = {
	relativePath: string;
	existedBefore: boolean;
	baselineDiagnostics: Diagnostic[] | null;
};

const NOOP_NOTIFY: NotifyFn = () => {};

// ---------------------------------------------------------------------------
// ProblemsTracker
// ---------------------------------------------------------------------------

export class ProblemsTracker {
	private service: JetBrainsService | null = null;
	private configPath: string | null = null;
	private projectPath: string | null = null;
	private readonly pendingMutations = new Map<string, PendingMutationContext>();
	private lastError: string | undefined;
	private readonly notify: NotifyFn;

	constructor(notify?: NotifyFn) {
		this.notify = notify ?? NOOP_NOTIFY;
	}

	isInitialized(): boolean {
		return this.service !== null && this.projectPath !== null;
	}

	getStatus(): ProblemsTrackerStatus {
		return {
			initialized: this.isInitialized(),
			connected: this.isInitialized() && this.service !== null && this.service.isConnected,
			configPath: this.configPath ?? undefined,
			lastError: this.lastError,
		};
	}

	getStatusLine(): string {
		return formatProblemsTrackerStatus(this.getStatus());
	}

	/**
	 * Initialize a connection to the JetBrains index MCP service.
	 *
	 * - Checks for .idea/ directory.
	 * - Loads connection config (prefers settings.json, falls back to mcp.json).
	 * - Creates a JetBrainsService and validates connectivity.
	 */
	async initialize(cwd: string): Promise<boolean> {
		const normalizedCwd = resolve(cwd);

		if (!hasIdeaDirectory(normalizedCwd)) {
			this.lastError = "JetBrains index diagnostics requires a .idea directory in the current working directory.";
			return false;
		}

		if (this.service && this.projectPath === normalizedCwd) {
			const healthy = await this.service.probe();
			if (healthy) {
				this.lastError = undefined;
				return true;
			}

			this.lastError = "JetBrains index MCP connectivity probe failed.";
			this.notify(`JetBrains index diagnostics disabled: ${this.lastError}`, "warning");
			return false;
		}

		await this.shutdown();

		const config = loadJetBrainsConfig(normalizedCwd);
		if (!config) {
			this.lastError =
				"JetBrains MCP server 'jetbrains-index' was not found in settings.json or mcp.json.";
			return false;
		}

		const service = new JetBrainsService(config.url, config.headers, this.notify);
		const healthy = await service.probe();
		if (!healthy) {
			this.lastError = "JetBrains index MCP initial connection failed.";
			this.notify(`JetBrains index diagnostics disabled: ${this.lastError}`, "error");
			await service.shutdown();
			return false;
		}

		// Scope service to this project
		service.projectPath = normalizedCwd;

		this.service = service;
		this.configPath = config.configPath;
		this.projectPath = normalizedCwd;
		this.lastError = undefined;
		return true;
	}

	reset(): void {
		this.pendingMutations.clear();
	}

	/**
	 * Check if the IDE index is ready for this project.
	 */
	async checkIndexReady(): Promise<{ ready: boolean; message?: string }> {
		if (!(this.service && this.projectPath)) {
			return { ready: false, message: "No active JetBrains connection for this project." };
		}

		return this.service.waitForIndexReady();
	}

	/**
	 * Sync the entire project directory via the IDE index.
	 */
	async syncProject(): Promise<boolean> {
		if (!this.service) {
			return false;
		}

		return this.service.syncProject();
	}

	/**
	 * Get the underlying JetBrains service for direct access.
	 */
	getClient(): JetBrainsService | null {
		return this.service;
	}

	/**
	 * Get the current project path.
	 */
	getProjectPath(): string | null {
		return this.projectPath;
	}

	async shutdown(): Promise<void> {
		this.reset();
		await this.service?.shutdown();
		this.service = null;
		this.configPath = null;
		this.projectPath = null;
	}

	async beforeFileMutation(filePath: string): Promise<BeforeMutationResult> {
		if (!(this.service && this.projectPath)) {
			return { allowed: true };
		}

		const absolutePath = resolve(filePath);
		const normalizedPath = normalizePathForComparison(absolutePath);
		const relativePath = toProjectRelativePath(this.projectPath, absolutePath);

		if (!relativePath) {
			this.pendingMutations.delete(normalizedPath);
			return { allowed: true };
		}

		const readiness = await this.service.waitForIndexReady();
		if (!readiness.ready) {
			this.pendingMutations.delete(normalizedPath);
			return {
				allowed: false,
				reason: readiness.message ?? "IDE index is not ready. Try again when indexing completes.",
			};
		}

		const existedBefore = existsSync(absolutePath);
		let baselineDiagnostics: Diagnostic[] | null = null;
		if (existedBefore) {
			baselineDiagnostics = await this.service.getFileDiagnostics(relativePath);
		}

		this.pendingMutations.set(normalizedPath, {
			relativePath,
			existedBefore,
			baselineDiagnostics,
		});

		return { allowed: true };
	}

	discardPending(filePath: string): void {
		const normalizedPath = normalizePathForComparison(resolve(filePath));
		this.pendingMutations.delete(normalizedPath);
	}

	async getNewProblems(filePaths: string[]): Promise<DiagnosticFile[]> {
		if (!(this.service && this.projectPath)) {
			return [];
		}

		const dedupedAbsolutePaths = Array.from(new Set(filePaths.map((filePath) => resolve(filePath))));
		const newProblemFiles: DiagnosticFile[] = [];

		for (const absolutePath of dedupedAbsolutePaths) {
			const normalizedPath = normalizePathForComparison(absolutePath);
			const pending = this.pendingMutations.get(normalizedPath);
			this.pendingMutations.delete(normalizedPath);

			if (!pending) {
				continue;
			}

			// Run shared diagnostics preflight protocol
			const preflight = await prepareFileForDiagnostics(this.service, pending.relativePath);
			if (!preflight.ready) {
				this.notify(
					`Skipped diagnostics for ${pending.relativePath}: ${preflight.message}`,
					"error",
				);
				continue;
			}

			const currentDiagnostics = await this.service.getFileDiagnostics(pending.relativePath);
			const baseline = pending.baselineDiagnostics ?? [];

			const newlyIntroduced = pending.existedBefore
				? currentDiagnostics.filter(
					(diagnostic) => !baseline.some((existing) => areDiagnosticsEqual(diagnostic, existing)),
				)
				: currentDiagnostics;

			if (newlyIntroduced.length > 0) {
				newProblemFiles.push({
					uri: absolutePath,
					diagnostics: newlyIntroduced,
				});
			}
		}

		return newProblemFiles;
	}
}
