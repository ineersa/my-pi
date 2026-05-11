/**
 * Generic JetBrains IDE index MCP service layer.
 *
 * Manages transport, connectivity, tool catalog discovery, retries, and
 * reconnection — reused from the previous diagnostics-specific client.
 * Provides a small practical API for the rest of the extension.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encode as toonEncode } from "@toon-format/toon";
import {
	IDE_INDEX_STATUS_LAST_ATTEMPT_TIMEOUT_MS,
	IDE_INDEX_STATUS_MAX_RETRIES,
	IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS,
	IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS,
	MCP_CONNECT_TIMEOUT_MS,
	MCP_MAX_RETRIES,
	MCP_RECONNECT_DELAY_MS,
	MCP_RETRY_BASE_DELAY_MS,
	MCP_TOOL_CALL_TIMEOUT_MS,
} from "./constants.js";
import type { Diagnostic, DiagnosticSeverity } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

type JetBrainsProblem = {
	severity?: string;
	message?: string;
	description?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	source?: string;
	code?: string;
};

type NotifyFn = (message: string, level: "info" | "warning" | "error") => void;

const NOOP_NOTIFY: NotifyFn = () => {};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!(value && typeof value === "object")) {
		return null;
	}
	return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toNumberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toBooleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function mapSeverity(severity: string | undefined): DiagnosticSeverity {
	const normalized = severity?.toUpperCase() ?? "";
	if (normalized.includes("ERROR")) {
		return "Error";
	}
	if (normalized.includes("WARNING") || normalized.includes("WEAK")) {
		return "Warning";
	}
	if (normalized.includes("INFO")) {
		return "Info";
	}
	if (normalized.includes("HINT")) {
		return "Hint";
	}
	return "Warning";
}

function extractStructuredRecord(result: unknown): Record<string, unknown> | null {
	const direct = asRecord(result);
	if (!direct) {
		return null;
	}

	const structured = asRecord(direct.structuredContent);
	if (structured) {
		return structured;
	}

	if (Array.isArray(direct.content)) {
		for (const block of direct.content) {
			const blockRecord = asRecord(block);
			if (!blockRecord || blockRecord.type !== "text") {
				continue;
			}
			const text = toStringValue(blockRecord.text);
			if (!text) {
				continue;
			}
			const parsed = asRecord(parseJson(text));
			if (parsed) {
				return parsed;
			}
		}
	}

	return direct;
}

function extractProblems(result: unknown): JetBrainsProblem[] {
	const record = extractStructuredRecord(result);
	if (!record) {
		return [];
	}

	const rawProblems = record.problems;
	if (!Array.isArray(rawProblems)) {
		return [];
	}

	const problems: JetBrainsProblem[] = [];
	for (const value of rawProblems) {
		const item = asRecord(value);
		if (!item) {
			continue;
		}
		problems.push({
			severity: toStringValue(item.severity),
			message: toStringValue(item.message),
			description: toStringValue(item.description),
			line: toNumberValue(item.line),
			column: toNumberValue(item.column),
			endLine: toNumberValue(item.endLine),
			endColumn: toNumberValue(item.endColumn),
			source: toStringValue(item.source),
			code: toStringValue(item.code),
		});
	}
	return problems;
}

function problemToDiagnostic(problem: JetBrainsProblem): Diagnostic {
	const lineOneBased = Number.isFinite(problem.line) ? Math.max(1, problem.line ?? 1) : 1;
	const columnOneBased = Number.isFinite(problem.column) ? Math.max(1, problem.column ?? 1) : 1;
	const endLineOneBased = Number.isFinite(problem.endLine)
		? Math.max(lineOneBased, problem.endLine ?? lineOneBased)
		: lineOneBased;
	const endColumnOneBased = Number.isFinite(problem.endColumn)
		? Math.max(columnOneBased, problem.endColumn ?? columnOneBased)
		: columnOneBased + 1;

	return {
		message: problem.message ?? problem.description ?? "Inspection problem",
		severity: mapSeverity(problem.severity),
		range: {
			start: {
				line: lineOneBased - 1,
				character: columnOneBased - 1,
			},
			end: {
				line: endLineOneBased - 1,
				character: endColumnOneBased - 1,
			},
		},
		source: problem.source,
		code: problem.code,
	};
}

function parseIndexStatus(result: unknown): { isDumbMode: boolean; isIndexing: boolean } | null {
	const record = extractStructuredRecord(result);
	if (!record) {
		return null;
	}

	const isDumbMode = toBooleanValue(record.isDumbMode);
	const isIndexing = toBooleanValue(record.isIndexing);
	if (isDumbMode === undefined || isIndexing === undefined) {
		return null;
	}

	return { isDumbMode, isIndexing };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Map from logical tool keys to actual MCP tool names discovered at connect
 * time. `null` means the available toolset doesn't include that capability.
 */
export type ToolCatalog = {
	findFile: string | null;
	searchText: string | null;
	findClass: string | null;
	findSymbol: string | null;
	findDefinition: string | null;
	findReferences: string | null;
	diagnostics: string | null;
	indexStatus: string | null;
	syncFiles: string | null;
	openFile: string | null;
	rename: string | null;
	moveFile: string | null;
	typeHierarchy: string | null;
	callHierarchy: string | null;
	findImplementations: string | null;
	findSuperMethods: string | null;
	fileStructure: string | null;
};

export type JetBrainsToolKey = keyof ToolCatalog;

/** Raw MCP tool definition stored during catalog discovery. */
export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

export type CallResult = {
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type IndexReadinessResult = {
	ready: boolean;
	attempts: number;
	message?: string;
};

// ---------------------------------------------------------------------------
// Tool name resolution
// ---------------------------------------------------------------------------

const ALL_TOOL_CANDIDATES: Record<JetBrainsToolKey, string[]> = {
	findFile: ["ide_find_file", "jetbrains_index_ide_find_file"],
	searchText: ["ide_search_text", "jetbrains_index_ide_search_text"],
	findClass: ["ide_find_class", "jetbrains_index_ide_find_class"],
	findSymbol: ["ide_find_symbol", "jetbrains_index_ide_find_symbol"],
	findDefinition: ["ide_find_definition", "jetbrains_index_ide_find_definition"],
	findReferences: ["ide_find_references", "jetbrains_index_ide_find_references"],
	diagnostics: ["ide_diagnostics", "jetbrains_index_ide_diagnostics"],
	indexStatus: ["ide_index_status", "jetbrains_index_ide_index_status"],
	syncFiles: ["ide_sync_files", "jetbrains_index_ide_sync_files"],
	openFile: ["ide_open_file", "jetbrains_index_ide_open_file"],
	rename: ["ide_refactor_rename", "jetbrains_index_ide_refactor_rename"],
	moveFile: ["ide_move_file", "jetbrains_index_ide_move_file"],
	typeHierarchy: ["ide_type_hierarchy", "jetbrains_index_ide_type_hierarchy"],
	callHierarchy: ["ide_call_hierarchy", "jetbrains_index_ide_call_hierarchy"],
	findImplementations: ["ide_find_implementations", "jetbrains_index_ide_find_implementations"],
	findSuperMethods: ["ide_find_super_methods", "jetbrains_index_ide_find_super_methods"],
	fileStructure: ["ide_file_structure", "jetbrains_index_ide_file_structure"],
};

/**
 * Tools that must be present for the extension to function.
 */
const REQUIRED_TOOL_KEYS: (keyof Omit<ToolCatalog, "openFile">)[] = [
	"indexStatus",
	"diagnostics",
	"syncFiles",
];

function pickToolName(available: Set<string>, candidates: string[]): string | null {
	for (const candidate of candidates) {
		if (available.has(candidate)) {
			return candidate;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class JetBrainsService {
	private client: Client | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private connectionState: "disconnected" | "connecting" | "connected" = "disconnected";
	private connectPromise: Promise<void> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private shuttingDown = false;
	private catalog: ToolCatalog | null = null;
	/** Full MCP tool definitions keyed by resolved tool name. */
	private toolMetadata = new Map<string, MCPToolDefinition>();
	private _projectPath: string | null = null;

	constructor(
		private readonly endpointUrl: string,
		private readonly headers: Record<string, string>,
		private readonly notify: NotifyFn = NOOP_NOTIFY,
	) {}

	// -----------------------------------------------------------------------
	// Connection management
	// -----------------------------------------------------------------------

	get isConnected(): boolean {
		return this.connectionState === "connected" && this.client !== null;
	}

	/** The project path this service instance is scoped to. */
	get projectPath(): string | null {
		return this._projectPath;
	}

	/** Scope the service to a specific project path (typically ctx.cwd). */
	set projectPath(value: string | null) {
		this._projectPath = value;
	}

	/** Return the discovered tool catalog, or null before first connect. */
	getCatalog(): ToolCatalog | null {
		return this.catalog;
	}

	/**
	 * Get the original MCP tool definition for a logical tool key.
	 * Returns null if the tool is not in the catalog or metadata is missing.
	 */
	getToolMetadata(toolKey: JetBrainsToolKey): MCPToolDefinition | null {
		const toolName = this.catalog?.[toolKey];
		if (!toolName) return null;
		return this.toolMetadata.get(toolName) ?? null;
	}

	/**
	 * Get all stored MCP tool definitions.
	 */
	getAllToolMetadata(): Map<string, MCPToolDefinition> {
		return this.toolMetadata;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected" && this.client) {
			return;
		}

		if (this.connectionState === "connecting" && this.connectPromise) {
			await this.connectPromise;
			return;
		}

		this.connectPromise = this.doConnect();
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	private async doConnect(): Promise<void> {
		this.connectionState = "connecting";
		this.shuttingDown = false;

		try {
			const url = new URL(this.endpointUrl);
			const transport = new StreamableHTTPClientTransport(url, {
				requestInit: {
					headers: this.headers,
				},
			});

			const client = new Client(
				{ name: "my-pi-jetbrains-index", version: "1.0.0" },
				{ capabilities: {} },
			);

			client.onclose = () => {
				if (!this.shuttingDown) {
					this.connectionState = "disconnected";
					this.notify("JetBrains index MCP connection closed. Reconnecting…", "warning");
					this.scheduleReconnect();
				}
			};

			client.onerror = (error) => {
				const msg = error?.message ?? String(error);
				this.notify(`JetBrains index MCP transport error: ${msg}`, "warning");
			};

			await this.withTimeout(
				client.connect(transport),
				MCP_CONNECT_TIMEOUT_MS,
				`Timed out connecting to JetBrains index MCP (${this.endpointUrl})`,
			);

			const catalog = await this.discoverToolCatalog(client);

			this.client = client;
			this.transport = transport;
			this.catalog = catalog;
			this.connectionState = "connected";
		} catch (error) {
			this.connectionState = "disconnected";
			const message = error instanceof Error ? error.message : String(error);
			this.notify(`Failed to connect to JetBrains index MCP: ${message}`, "error");
			throw error;
		}
	}

	private async discoverToolCatalog(client: Client): Promise<ToolCatalog> {
		const available = new Set<string>();
		let cursor: string | undefined;

		do {
			const response = await client.listTools(cursor ? { cursor } : undefined);
			for (const tool of response.tools ?? []) {
				if (tool?.name) {
					available.add(tool.name);
					// Store full tool definition for wrapper reuse
					this.toolMetadata.set(tool.name, {
						name: tool.name,
						description: tool.description,
						inputSchema: (tool.inputSchema as Record<string, unknown>) ?? undefined,
						outputSchema: (tool.outputSchema as Record<string, unknown>) ?? undefined,
					});
				}
			}
			cursor = response.nextCursor;
		} while (cursor);

		// Build catalog from all known tool candidates
		const catalog: ToolCatalog = {} as ToolCatalog;
		for (const [key, candidates] of Object.entries(ALL_TOOL_CANDIDATES)) {
			(catalog as Record<string, string | null>)[key] = pickToolName(available, candidates);
		}

		// Validate required tools
		for (const requiredKey of REQUIRED_TOOL_KEYS) {
			if (!catalog[requiredKey]) {
				const candidates = ALL_TOOL_CANDIDATES[requiredKey].join(", ");
				throw new Error(
					`JetBrains index MCP server is missing required tool '${requiredKey}' (candidates: ${candidates})`,
				);
			}
		}

		return catalog;
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.cancelReconnect();

		const client = this.client;
		const transport = this.transport;

		this.client = null;
		this.transport = null;
		this.catalog = null;
		this.toolMetadata.clear();
		this.connectionState = "disconnected";

		if (client) {
			try {
				await client.close();
			} catch {
				// Best effort.
			}
		}
		if (transport) {
			try {
				await transport.close();
			} catch {
				// Best effort.
			}
		}
	}

	private scheduleReconnect(): void {
		this.cancelReconnect();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.attemptReconnect();
		}, MCP_RECONNECT_DELAY_MS);
	}

	private cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private async attemptReconnect(): Promise<void> {
		if (this.shuttingDown || this.connectionState === "connected") {
			return;
		}

		try {
			await this.cleanupInternals();
			await this.connect();
			this.notify("JetBrains index MCP reconnected.", "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notify(`JetBrains index MCP reconnect failed: ${message}`, "error");
			this.scheduleReconnect();
		}
	}

	private async cleanupInternals(): Promise<void> {
		const client = this.client;
		const transport = this.transport;

		this.client = null;
		this.transport = null;
		this.catalog = null;
		this.toolMetadata.clear();
		this.connectionState = "disconnected";

		if (client) {
			try {
				await client.close();
			} catch {
				// Best effort.
			}
		}
		if (transport) {
			try {
				await transport.close();
			} catch {
				// Best effort.
			}
		}
	}

	/**
	 * Check connectivity by pinging the MCP server.
	 * Does not throw — returns boolean.
	 */
	async probe(): Promise<boolean> {
		try {
			await this.connect();
			if (this.client) {
				await this.withTimeout(
					this.client.ping(),
					MCP_TOOL_CALL_TIMEOUT_MS,
					"JetBrains index MCP ping timed out",
				);
			}
			return true;
		} catch {
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Readiness
	// -----------------------------------------------------------------------

	/**
	 * Wait until the IDE index is ready (not dumb mode, not indexing).
	 * Uses the configured project path.
	 */
	async waitForIndexReady(): Promise<IndexReadinessResult> {
		if (!this._projectPath) {
			return { ready: false, attempts: 0, message: "No project path configured." };
		}

		let lastMessage = "Unable to query IDE index status.";

		for (let attempt = 1; attempt <= IDE_INDEX_STATUS_MAX_RETRIES; attempt++) {
			const isLastAttempt = attempt === IDE_INDEX_STATUS_MAX_RETRIES;
			const status = await this.getIndexStatus(isLastAttempt);

			if (!status) {
				if (!isLastAttempt) {
					const delay = Math.min(
						IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
						IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS,
					);
					this.notify(
						`IDE index status unavailable (attempt ${attempt}/${IDE_INDEX_STATUS_MAX_RETRIES}). Retrying in ${delay / 1000}s…`,
						"warning",
					);
					await this.sleep(delay);
					continue;
				}
				return { ready: false, attempts: attempt, message: lastMessage };
			}

			if (!status.isDumbMode && !status.isIndexing) {
				return { ready: true, attempts: attempt };
			}

			if (!isLastAttempt) {
				const delay = Math.min(
					IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
					IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS,
				);
				this.notify(
					`IDE index is busy (attempt ${attempt}/${IDE_INDEX_STATUS_MAX_RETRIES}). Waiting ${delay / 1000}s…`,
					"warning",
				);
				await this.sleep(delay);
			}
		}

		return {
			ready: false,
			attempts: IDE_INDEX_STATUS_MAX_RETRIES,
			message: "IDE index stayed in dumb/indexing mode after retries.",
		};
	}

	// -----------------------------------------------------------------------
	// File operations
	// -----------------------------------------------------------------------

	/**
	 * Sync one or more relative paths in the IDE index.
	 */
	async syncFiles(relativePaths: string[]): Promise<boolean> {
		if (relativePaths.length === 0) {
			return true;
		}

		const call = await this.call("syncFiles", { paths: relativePaths });
		if (!call.ok) {
			this.notify(
				`Failed to sync files with IDE index: ${call.error ?? "unknown error"}`,
				"error",
			);
			return false;
		}
		return true;
	}

	/**
	 * Sync the entire project by syncing the root path.
	 */
	async syncProject(): Promise<boolean> {
		return this.syncFiles(["."]);
	}

	/**
	 * Open a file in the IDE (best-effort — may be unavailable).
	 */
	async openFile(relativeFilePath: string, line?: number, column?: number): Promise<boolean> {
		const catalog = this.catalog;
		const toolName = catalog?.openFile;
		if (!toolName) {
			return false;
		}

		for (let attempt = 1; attempt <= MCP_MAX_RETRIES; attempt++) {
			try {
				await this.connect();
				if (!this.client) {
					throw new Error("JetBrains index MCP client is not connected");
				}

				const args: Record<string, unknown> = {
					project_path: this._projectPath,
					file: relativeFilePath,
				};
				if (line !== undefined) {
					args.line = line;
				}
				if (column !== undefined) {
					args.column = column;
				}

				const result = await this.withTimeout(
					this.client.callTool({ name: toolName, arguments: args }),
					MCP_TOOL_CALL_TIMEOUT_MS,
					`Timed out waiting for MCP response (${toolName})`,
				);
				return !result.isError;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (this.isConnectionError(error instanceof Error ? error : new Error(msg))) {
					await this.cleanupInternals();
				}
				if (attempt < MCP_MAX_RETRIES) {
					await this.sleep(MCP_RETRY_BASE_DELAY_MS * attempt);
				}
			}
		}

		return false;
	}

	// -----------------------------------------------------------------------
	// Diagnostics
	// -----------------------------------------------------------------------

	/**
	 * Fetch diagnostics for a single file.
	 */
	async getFileDiagnostics(relativeFilePath: string): Promise<Diagnostic[]> {
		const call = await this.call("diagnostics", {
			file: relativeFilePath,
			severity: "all",
		});
		if (!call.ok) {
			this.notify(
				`Failed to fetch IDE diagnostics for ${relativeFilePath}: ${call.error ?? "unknown error"}`,
				"error",
			);
			return [];
		}

		const problems = extractProblems(call.result);
		return problems.map((problem) => problemToDiagnostic(problem));
	}

	// -----------------------------------------------------------------------
	// Generic tool calls
	// -----------------------------------------------------------------------

	/**
	 * Call a JetBrains IDE tool by logical key.
	 * The key is resolved to the actual MCP tool name via the catalog.
	 * `project_path` is auto-injected from the configured project path.
	 */
	async call(toolKey: JetBrainsToolKey, args: Record<string, unknown>): Promise<CallResult> {
		if (!this.catalog) {
			return { ok: false, error: "JetBrains service not connected: no tool catalog available." };
		}

		const toolName = this.catalog[toolKey];
		if (!toolName) {
			return {
				ok: false,
				error: `IDE tool '${toolKey}' is not available in the current catalog.`,
			};
		}

		return this.callRaw(toolName, args);
	}

	/**
	 * Call any MCP tool by its actual name.
	 * `project_path` is auto-injected from the configured project path.
	 */
	async callRaw(toolName: string, args: Record<string, unknown>): Promise<CallResult> {
		const resolvedArgs = this._projectPath && !args.project_path
			? { ...args, project_path: this._projectPath }
			: args;

		return this.callToolInternal(toolName, resolvedArgs);
	}

	/**
	 * Low-level retry loop for MCP tool calls.
	 */
	private async callToolInternal(
		toolName: string,
		args: Record<string, unknown>,
		extendedTimeout = false,
	): Promise<CallResult> {
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= MCP_MAX_RETRIES; attempt++) {
			try {
				await this.connect();
				if (!this.client || !this.catalog) {
					throw new Error("JetBrains index MCP client is not connected");
				}

				const timeout = extendedTimeout && attempt === MCP_MAX_RETRIES
					? IDE_INDEX_STATUS_LAST_ATTEMPT_TIMEOUT_MS
					: MCP_TOOL_CALL_TIMEOUT_MS;

				const result = await this.withTimeout(
					this.client.callTool({ name: toolName, arguments: args }),
					timeout,
					`Timed out waiting for MCP response (${toolName})`,
				);
				return { ok: true, result };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const isConnError = this.isConnectionError(lastError);
				const level: "warning" | "error" = isConnError ? "warning" : "error";
				this.notify(
					`JetBrains index MCP call failed (attempt ${attempt}/${MCP_MAX_RETRIES}): ${lastError.message}`,
					level,
				);

				if (isConnError) {
					await this.cleanupInternals();
				}

				if (attempt < MCP_MAX_RETRIES) {
					await this.sleep(MCP_RETRY_BASE_DELAY_MS * attempt);
				}
			}
		}

		return { ok: false, error: lastError?.message ?? "Unknown MCP tool error" };
	}

	// -----------------------------------------------------------------------
	// Index status (internal)
	// -----------------------------------------------------------------------

	private async getIndexStatus(
		extendedTimeout = false,
	): Promise<{ isDumbMode: boolean; isIndexing: boolean } | null> {
		const toolName = this.catalog?.indexStatus ?? "ide_index_status";
		const call = await this.callToolInternal(
			toolName,
			{ project_path: this._projectPath },
			extendedTimeout,
		);
		if (!call.ok) {
			this.notify(`Failed to query IDE index status: ${call.error ?? "unknown error"}`, "error");
			return null;
		}

		const status = parseIndexStatus(call.result);
		if (!status) {
			this.notify("IDE index status response was malformed.", "error");
			return null;
		}

		return status;
	}

	// -----------------------------------------------------------------------
	// Result encoding and MCP payload helpers (for wrapper tools)
	// -----------------------------------------------------------------------

	/**
	 * Encode data as TOON text for model consumption.
	 * Always TOON. Never JSON fallback. Strings pass through as-is.
	 */
	toToon(data: unknown): string {
		if (typeof data === "string") return data;
		if (typeof data !== "object" || data === null) {
			return String(data);
		}
		try {
			return toonEncode(data);
		} catch {
			return JSON.stringify(data);
		}
	}

	/**
	 * Extract text blocks from an MCP ToolResult content array.
	 */
	private extractMcpTextBlocks(result: unknown): string[] {
		const rec = asRecord(result);
		if (!rec) return [];
		const content = rec.content;
		if (!Array.isArray(content)) return [];
		const texts: string[] = [];
		for (const block of content) {
			const b = asRecord(block);
			if (b?.type === "text" && typeof b.text === "string") {
				texts.push(b.text);
			}
		}
		return texts;
	}

	/**
	 * Check whether an MCP ToolResult indicates an error.
	 */
	isMcpError(result: unknown): boolean {
		const rec = asRecord(result);
		return rec?.isError === true;
	}

	/**
	 * Extract the first meaningful error text from an MCP error result.
	 */
	getMcpErrorText(result: unknown): string | undefined {
		const texts = this.extractMcpTextBlocks(result);
		return texts.length > 0 ? texts.join("\n") : undefined;
	}

	/**
	 * Decode the actual data payload from a JetBrains MCP tool result.
	 *
	 * The MCP backend wraps data in content blocks:
	 *   { content: [{ type: "text", text: "<JSON string>" }], isError: false }
	 *
	 * This helper extracts content[0].text, JSON-decodes if the text is JSON,
	 * and returns the decoded data. Multiple blocks are decoded individually.
	 * Falls back to the raw result object if no text blocks are found.
	 */
	decodeMcpPayload(result: unknown): unknown {
		const texts = this.extractMcpTextBlocks(result);
		if (texts.length === 0) {
			// No text blocks found — return the raw result as fallback
			return result;
		}

		if (texts.length === 1) {
			const parsed = parseJson(texts[0]);
			return parsed ?? texts[0];
		}

		// Multiple text blocks — decode each individually
		return texts.map((t) => {
			const parsed = parseJson(t);
			return parsed ?? t;
		});
	}

	/**
	 * Encode data as TOON text for model consumption.
	 * Always returns TOON; falls back to JSON only if encoding throws.
	 *
	 * @deprecated Use toToon() + decodeMcpPayload() instead.
	 */
	toonOrJson(data: unknown): string {
		if (typeof data !== "object" || data === null) {
			return JSON.stringify(data);
		}
		try {
			return toonEncode(data);
		} catch {
			return JSON.stringify(data, null, 2);
		}
	}

	/**
	 * Build a standard error object for MCP tool failures.
	 */
	makeError(error: string, hint: string, isRetryable: boolean): Record<string, unknown> {
		return { error, hint, isRetryable };
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private isConnectionError(error: Error): boolean {
		const msg = error.message.toLowerCase();
		return (
			msg.includes("timeout")
			|| msg.includes("terminated")
			|| msg.includes("fetch failed")
			|| msg.includes("aborted")
			|| msg.includes("econnrefused")
			|| msg.includes("econnreset")
			|| msg.includes("not connected")
			|| msg.includes("closed")
		);
	}

	private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const handle = setTimeout(() => reject(new Error(message)), ms);
			promise.then(
				(value) => {
					clearTimeout(handle);
					resolve(value);
				},
				(error) => {
					clearTimeout(handle);
					reject(error);
				},
			);
		});
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
