import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { areDiagnosticsEqual, type Diagnostic, type DiagnosticFile } from "./diagnostics.js";
import { findJetBrainsMcpServer, type JetBrainsMcpServerConfig } from "./mcp-config.js";
import { McpProblemsClient } from "./mcp-problems-client.js";

export type ProblemsTrackerStatus = {
	initialized: boolean;
	connected: boolean;
	serverName?: string;
	sseUrl?: string;
	configPath?: string;
	lastError?: string;
};

export function formatProblemsTrackerStatus(status: ProblemsTrackerStatus): string {
	if (!status.initialized) {
		return status.lastError
			? `problems tracker: unavailable (${status.lastError})`
			: "problems tracker: unavailable";
	}

	const endpoint = status.sseUrl ?? "(unknown endpoint)";
	const serverName = status.serverName ?? "jetbrains-index";
	if (!status.connected) {
		return `problems tracker: disconnected (${serverName} @ ${endpoint})`;
	}

	return `problems tracker: connected (${serverName} @ ${endpoint})`;
}

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

export class ProblemsTracker {
	private client: McpProblemsClient | null = null;
	private config: JetBrainsMcpServerConfig | null = null;
	private projectPath: string | null = null;
	private readonly pendingMutations = new Map<string, PendingMutationContext>();
	private lastError: string | undefined;
	private readonly notify: NotifyFn;

	constructor(notify?: NotifyFn) {
		this.notify = notify ?? NOOP_NOTIFY;
	}

	isInitialized(): boolean {
		return this.client !== null && this.projectPath !== null;
	}

	getStatus(): ProblemsTrackerStatus {
		return {
			initialized: this.isInitialized(),
			connected: this.isInitialized() && this.client !== null && this.client.isConnected,
			serverName: this.config?.serverName,
			sseUrl: this.config?.sseUrl,
			configPath: this.config?.configPath,
			lastError: this.lastError,
		};
	}

	getStatusLine(): string {
		return formatProblemsTrackerStatus(this.getStatus());
	}

	async initialize(cwd: string): Promise<boolean> {
		const normalizedCwd = resolve(cwd);

		if (!hasIdeaDirectory(normalizedCwd)) {
			this.lastError = "JetBrains index diagnostics requires a .idea directory in the current working directory.";
			return false;
		}

		if (this.client && this.projectPath === normalizedCwd) {
			const healthy = await this.client.probe();
			if (healthy) {
				this.lastError = undefined;
				return true;
			}

			this.lastError = "JetBrains index MCP connectivity probe failed.";
			this.notify(`JetBrains index diagnostics disabled: ${this.lastError}`, "warning");
			return false;
		}

		await this.shutdown();

		const config = findJetBrainsMcpServer(normalizedCwd);
		if (!config) {
			this.lastError = "JetBrains MCP server 'jetbrains-index' was not found in .pi/mcp.json or ~/.pi/agent/mcp.json.";
			return false;
		}

		const client = new McpProblemsClient(config.sseUrl, config.headers, this.notify);
		const healthy = await client.probe();
		if (!healthy) {
			this.lastError = "JetBrains index MCP initial connection failed.";
			this.notify(`JetBrains index diagnostics disabled: ${this.lastError}`, "error");
			await client.shutdown();
			return false;
		}

		this.client = client;
		this.config = config;
		this.projectPath = normalizedCwd;
		this.lastError = undefined;
		return true;
	}

	reset(): void {
		this.pendingMutations.clear();
	}

	async shutdown(): Promise<void> {
		this.reset();
		await this.client?.shutdown();
		this.client = null;
		this.config = null;
		this.projectPath = null;
	}

	async beforeFileMutation(filePath: string): Promise<BeforeMutationResult> {
		const client = this.client;
		const projectPath = this.projectPath;
		if (!(client && projectPath)) {
			return {
				allowed: true,
			};
		}

		const absolutePath = resolve(filePath);
		const normalizedPath = normalizePathForComparison(absolutePath);
		const relativePath = toProjectRelativePath(projectPath, absolutePath);

		if (!relativePath) {
			this.pendingMutations.delete(normalizedPath);
			return {
				allowed: true,
			};
		}

		const readiness = await client.waitForIndexReady(projectPath);
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
			baselineDiagnostics = await client.getFileDiagnostics(relativePath, projectPath);
		}

		this.pendingMutations.set(normalizedPath, {
			relativePath,
			existedBefore,
			baselineDiagnostics,
		});

		return {
			allowed: true,
		};
	}

	discardPending(filePath: string): void {
		const normalizedPath = normalizePathForComparison(resolve(filePath));
		this.pendingMutations.delete(normalizedPath);
	}

	async getNewProblems(filePaths: string[]): Promise<DiagnosticFile[]> {
		const client = this.client;
		const projectPath = this.projectPath;
		if (!(client && projectPath)) {
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

			const synced = await client.syncFiles([pending.relativePath], projectPath);
			if (!synced) {
				continue;
			}

			const readiness = await client.waitForIndexReady(projectPath);
			if (!readiness.ready) {
				this.notify(
					`Skipped diagnostics for ${pending.relativePath}: ${readiness.message ?? "IDE index is not ready."}`,
					"error",
				);
				continue;
			}

			const currentDiagnostics = await client.getFileDiagnostics(pending.relativePath, projectPath);
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
