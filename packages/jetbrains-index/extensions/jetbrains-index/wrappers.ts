/**
 * First-class Pi wrapper tools for JetBrains IDE index operations.
 *
 * Each wrapper:
 *  - Uses original MCP tool descriptions from stored metadata (no fallback).
 *  - Sources inherited parameter descriptions from MCP inputSchema metadata
 *    exactly as returned by tools/list. New wrapper-only params get new
 *    descriptions.
 *  - Returns MCP-native results: TOON text + isError flag.
 *  - Resolver-backed tools use target-resolver.ts before calling IDE tools.
 */
import { Type, type TObject } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { JetBrainsService, type JetBrainsToolKey, type MCPToolDefinition } from "./jetbrains-service.js";
import { resolveTarget, type TargetInput } from "./target-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape for extension context used in execute(). */
type ExecCtx = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

type ContentBlock = { type: "text"; text: string };

type ToolResult = {
	content: ContentBlock[];
	isError?: boolean;
};

type ToolRegistration = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TObject;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: { aborted: boolean } | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: ExecCtx,
	) => Promise<ToolResult>;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Get a parameter description from the stored MCP inputSchema metadata.
 * Returns the original MCP description, or empty string if unavailable.
 * Never invents a fallback description.
 */
function getParamDesc(meta: MCPToolDefinition | null, paramName: string): string {
	const props = meta?.inputSchema?.properties as Record<string, { description?: string }> | undefined;
	const d = props?.[paramName]?.description;
	return typeof d === "string" ? d : "";
}

/**
 * Get the tool description from stored MCP metadata.
 * Returns the original MCP description, or empty string if unavailable.
 * No fallback — if the MCP server didn't provide a description, we don't invent one.
 */
function getToolDesc(meta: MCPToolDefinition | null): string {
	return meta?.description ?? "";
}

/**
 * Call a backend IDE tool and return an MCP-native result.
 *
 * Decodes the MCP ToolResult wrapper to extract the actual data payload,
 * then TOON-encodes the decoded data for model consumption.
 *
 * Success → TOON-encoded decoded payload, no isError (undefined = false).
 * MCP-level error → { error, hint, isRetryable } TOON, isError: true.
 * Transport/service error → same error shape, isError: true.
 */
async function callTool(
	service: JetBrainsService,
	toolKey: JetBrainsToolKey,
	args: Record<string, unknown>,
	hint = "Check IDE connection and try again.",
	isRetryable = true,
): Promise<ToolResult> {
	try {
		const call = await service.call(toolKey, args);

		// Service-level transport/connectivity error
		if (!call.ok) {
			const payload = service.makeError(call.error ?? "Tool call failed", hint, isRetryable);
			return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
		}

		// MCP-level error (backend returned isError: true, e.g. "No class/type found")
		if (service.isMcpError(call.result)) {
			const errorText = service.getMcpErrorText(call.result) ?? "IDE tool returned an error";
			const payload = service.makeError(errorText, hint, isRetryable);
			return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
		}

		// Success: decode the actual data payload from MCP content blocks
		const payload = service.decodeMcpPayload(call.result);
		return { content: [{ type: "text", text: service.toToon(payload) }] };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const payload = service.makeError(msg, hint, isRetryable);
		return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
	}
}

/**
 * Resolve a target (symbol or location) and return canonical `{ file, line, column }`
 * plus any tool-specific args merged in. If resolution fails, return an error ToolResult.
 */
async function resolveAndMerge(
	service: JetBrainsService,
	params: Record<string, unknown>,
	cwd: string,
	toolArgs: Record<string, unknown>,
): Promise<Record<string, unknown> | ToolResult> {
	const targetInput: TargetInput = {};
	if (typeof params.file === "string") targetInput.file = params.file;
	if (typeof params.line === "number") targetInput.line = params.line;
	if (typeof params.column === "number") targetInput.column = params.column;
	if (typeof params.symbol === "string") targetInput.symbol = params.symbol;
	if (typeof params.language === "string") targetInput.language = params.language;
	if (typeof params.kind === "string") targetInput.kind = params.kind;
	if (typeof params.fileHint === "string") targetInput.fileHint = params.fileHint;

	const hasFullLocation = targetInput.file && targetInput.line !== undefined && targetInput.column !== undefined;
	const hasSymbol = !!targetInput.symbol;

	if (!hasFullLocation && !hasSymbol) {
		const payload = service.makeError(
			"Provide file+line+column, or symbol.",
			"Use file+line+column when known; otherwise provide symbol.",
			false,
		);
		return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
	}

	if (hasFullLocation) {
		const resolved = await resolveTarget(targetInput, service, cwd);
		if (resolved.status === "ok") {
			return { ...toolArgs, file: resolved.file, line: resolved.line, column: resolved.column };
		}
		return resolveErrorToResult(service, resolved);
	}

	// Symbol mode
	const resolved = await resolveTarget(targetInput, service, cwd);
	if (resolved.status === "ok") {
		return { ...toolArgs, file: resolved.file, line: resolved.line, column: resolved.column };
	}
	return resolveErrorToResult(service, resolved);
}

function resolveErrorToResult(
	service: JetBrainsService,
	result: { status: string; summary: string; hint?: string },
): ToolResult {
	const payload = service.makeError(
		result.summary,
		result.hint ?? "Try file+line+column targeting instead.",
		false,
	);
	return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
}

// ---------------------------------------------------------------------------
// Mutation lock
// ---------------------------------------------------------------------------

let mutationLock: Promise<void> = Promise.resolve();

function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = mutationLock;
	let release: () => void;
	mutationLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	return prev.then(() => fn().finally(() => release!()));
}

// ---------------------------------------------------------------------------
// New wrapper-only targeting params (NOT from MCP metadata)
// ---------------------------------------------------------------------------

const kindEnum = StringEnum(
	["class", "interface", "trait", "enum", "method", "function", "field", "constant"] as const,
	{ description: "Symbol kind hint for narrowing resolution." },
);

const TargetParams = {
	file: Type.Optional(Type.String({ description: "Project-relative file path. Required with line+column for location mode." })),
	line: Type.Optional(Type.Number({ description: "1-based line number." })),
	column: Type.Optional(Type.Number({ description: "1-based column number." })),
	symbol: Type.Optional(Type.String({ description: "Symbol name to resolve. Can be qualified per language convention." })),
	language: Type.Optional(Type.String({ description: "Language hint: php, python, typescript, javascript, rust, go." })),
	kind: Type.Optional(kindEnum as any),
	fileHint: Type.Optional(Type.String({ description: "File path hint for narrowing JS/TS/Go symbol resolution. Strongly recommended for JS/TS." })),
};

// ---------------------------------------------------------------------------
// Thin wrappers
// ---------------------------------------------------------------------------

function createFindFile(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findFile");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		query: Type.String({ description: desc("query") }),
		scope: Type.Optional(Type.String({ description: desc("scope") })),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_file",
		label: "Find File (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Fast indexed file search by name with substring/wildcard matching",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return callTool(service, "findFile", params as Record<string, unknown>);
		},
	};
}

function createSearchText(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("searchText");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		query: Type.String({ description: desc("query") }),
		context: Type.Optional(StringEnum(["code", "comments", "strings", "all"] as const, { description: desc("context") }) as any),
		caseSensitive: Type.Optional(Type.Boolean({ description: desc("caseSensitive") })),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_search_text",
		label: "Search Text (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Fast indexed exact-word search across the project",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return callTool(service, "searchText", params as Record<string, unknown>);
		},
	};
}

function createMoveFile(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("moveFile");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		file: Type.String({ description: desc("file") }),
		newFile: Type.String({ description: desc("newFile") }),
	});

	return {
		name: "ide_move_file",
		label: "Move File (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Move a code file with automatic import/reference updates",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return withMutationLock(async () => {
				const result = await callTool(service, "moveFile", params as Record<string, unknown>);
				if (!result.isError) {
					await service.syncProject();
					await service.waitForIndexReady();
				}
				return result;
			});
		},
	};
}

function createFileStructure(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("fileStructure");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		file: Type.String({ description: desc("file") }),
	});

	return {
		name: "ide_file_structure",
		label: "File Structure (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Show file structure overview from IDE",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return callTool(service, "fileStructure", params as Record<string, unknown>);
		},
	};
}

// ---------------------------------------------------------------------------
// Merged symbol search
// ---------------------------------------------------------------------------

function createFindSymbol(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findSymbol");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		query: Type.String({ description: desc("query") }),
		kind: Type.Optional(StringEnum(
			["class", "interface", "trait", "enum", "method", "function", "field", "constant"] as const,
			{ description: desc("kind") },
		) as any),
		language: Type.Optional(Type.String({ description: desc("language") })),
		scope: Type.Optional(Type.String({ description: desc("scope") })),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_symbol",
		label: "Find Symbol (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Fast indexed symbol search across the project with optional kind/language filters",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = params as Record<string, unknown>;

			// If findSymbol is available, use it
			const catalog = service.getCatalog();
			if (catalog?.findSymbol) {
				const query: Record<string, unknown> = { query: args.query };
				if (typeof args.kind === "string") query.kind = args.kind;
				if (typeof args.language === "string") query.language = args.language;
				if (typeof args.scope === "string") query.scope = args.scope;
				if (typeof args.pageSize === "number") query.pageSize = args.pageSize;
				if (typeof args.cursor === "string") query.cursor = args.cursor;
				return callTool(service, "findSymbol", query);
			}

			// Fallback to findClass for class-like queries
			if (catalog?.findClass) {
				const query: Record<string, unknown> = { query: args.query };
				if (typeof args.pageSize === "number") query.pageSize = args.pageSize;
				if (typeof args.cursor === "string") query.cursor = args.cursor;
				return callTool(service, "findClass", query);
			}

			const payload = service.makeError(
				"No symbol search backend available.",
				"Enable findSymbol or findClass in the JetBrains IDE plugin.",
				false,
			);
			return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
		},
	};
}

// ---------------------------------------------------------------------------
// Resolver-backed semantic tools
// ---------------------------------------------------------------------------

function createDefinition(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findDefinition");

	const params = Type.Object({
		...TargetParams,
	});

	return {
		name: "ide_find_definition",
		label: "Find Definition (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Jump to symbol definition via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const merged = await resolveAndMerge(service, params as Record<string, unknown>, ctx.cwd, {});
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findDefinition", merged as Record<string, unknown>);
		},
	};
}

function createReferences(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findReferences");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		...TargetParams,
		scope: Type.Optional(Type.String({ description: desc("scope") })),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_references",
		label: "Find References (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Find all usages/references of a symbol via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const toolArgs: Record<string, unknown> = {};
			if (typeof p.scope === "string") toolArgs.scope = p.scope;
			if (typeof p.pageSize === "number") toolArgs.pageSize = p.pageSize;
			if (typeof p.cursor === "string") toolArgs.cursor = p.cursor;
			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findReferences", merged as Record<string, unknown>);
		},
	};
}

function createRename(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("rename");

	const params = Type.Object({
		...TargetParams,
		newName: Type.String({ description: "New name for the symbol." }),
	});

	return {
		name: "ide_refactor_rename",
		label: "Rename (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Rename a symbol with automatic reference updates via the IDE",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const newName = p.newName;
			if (typeof newName !== "string" || !newName.trim()) {
				const payload = service.makeError("newName is required.", "Provide the new name for the symbol.", false);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}
			const merged = await resolveAndMerge(service, p, ctx.cwd, { newName });
			if ("content" in merged) return merged as ToolResult;
			return withMutationLock(async () => {
				const result = await callTool(service, "rename", merged as Record<string, unknown>);
				if (!result.isError) {
					await service.syncProject();
					await service.waitForIndexReady();
				}
				return result;
			});
		},
	};
}

function createImplementations(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findImplementations");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		...TargetParams,
		scope: Type.Optional(Type.String({ description: desc("scope") })),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_implementations",
		label: "Find Implementations (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Find interface/abstract implementations via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const toolArgs: Record<string, unknown> = {};
			if (typeof p.scope === "string") toolArgs.scope = p.scope;
			if (typeof p.pageSize === "number") toolArgs.pageSize = p.pageSize;
			if (typeof p.cursor === "string") toolArgs.cursor = p.cursor;
			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findImplementations", merged as Record<string, unknown>);
		},
	};
}

function createSuperMethods(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findSuperMethods");

	const params = Type.Object({
		...TargetParams,
	});

	return {
		name: "ide_find_super_methods",
		label: "Find Super Methods (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Find parent overridden/implemented methods via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const merged = await resolveAndMerge(service, params as Record<string, unknown>, ctx.cwd, {});
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findSuperMethods", merged as Record<string, unknown>);
		},
	};
}

function createTypeHierarchy(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("typeHierarchy");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		...TargetParams,
		scope: Type.Optional(Type.String({ description: desc("scope") })),
	});

	return {
		name: "ide_type_hierarchy",
		label: "Type Hierarchy (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Show type hierarchy (supertypes/subtypes) via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const toolArgs: Record<string, unknown> = {};
			if (typeof p.scope === "string") toolArgs.scope = p.scope;
			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "typeHierarchy", merged as Record<string, unknown>);
		},
	};
}

function createCallHierarchy(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("callHierarchy");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		...TargetParams,
		direction: Type.Optional(StringEnum(["callers", "callees"] as const, { description: desc("direction") }) as any),
		depth: Type.Optional(Type.Number({ description: desc("depth") })),
		scope: Type.Optional(Type.String({ description: desc("scope") })),
	});

	return {
		name: "ide_call_hierarchy",
		label: "Call Hierarchy (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Show caller/callee hierarchy via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const toolArgs: Record<string, unknown> = {};
			if (typeof p.direction === "string") toolArgs.direction = p.direction;
			if (typeof p.depth === "number") toolArgs.depth = p.depth;
			if (typeof p.scope === "string") toolArgs.scope = p.scope;
			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "callHierarchy", merged as Record<string, unknown>);
		},
	};
}

// ---------------------------------------------------------------------------
// Unified diagnostics
// ---------------------------------------------------------------------------

function createDiagnostics(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("diagnostics");
	const desc = (k: string) => getParamDesc(meta, k);

	const params = Type.Object({
		file: Type.Optional(Type.String({ description: desc("file") })),
		line: Type.Optional(Type.Number({ description: desc("line") })),
		column: Type.Optional(Type.Number({ description: desc("column") })),
		startLine: Type.Optional(Type.Number({ description: desc("startLine") })),
		endLine: Type.Optional(Type.Number({ description: desc("endLine") })),
		includeBuildErrors: Type.Optional(Type.Boolean({ description: desc("includeBuildErrors") })),
		includeTestResults: Type.Optional(Type.Boolean({ description: desc("includeTestResults") })),
		severity: Type.Optional(StringEnum(["all", "errors", "warnings"] as const, { description: desc("severity") }) as any),
		testResultFilter: Type.Optional(StringEnum(["failed", "all"] as const, { description: desc("testResultFilter") }) as any),
		maxBuildErrors: Type.Optional(Type.Number({ description: desc("maxBuildErrors") })),
		maxTestResults: Type.Optional(Type.Number({ description: desc("maxTestResults") })),
	});

	return {
		name: "ide_diagnostics",
		label: "Diagnostics (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Get diagnostics (errors, warnings, hints, build errors, test results) from the IDE",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const p = params as Record<string, unknown>;

			// Best-effort open file in IDE
			if (typeof p.file === "string" && p.file.trim()) {
				await service.openFile(p.file.trim());
			}

			// Sync changed paths
			const paths: string[] = [];
			if (typeof p.file === "string" && p.file.trim()) {
				paths.push(p.file.trim());
			}

			if (paths.length > 0) {
				await service.syncFiles(paths);
			}

			// Wait for index
			await service.waitForIndexReady();

			// Build args for diagnostics call
			const args: Record<string, unknown> = {};
			if (typeof p.file === "string") args.file = p.file;
			if (typeof p.line === "number") args.line = p.line;
			if (typeof p.column === "number") args.column = p.column;
			if (typeof p.startLine === "number") args.startLine = p.startLine;
			if (typeof p.endLine === "number") args.endLine = p.endLine;
			if (typeof p.includeBuildErrors === "boolean") args.includeBuildErrors = p.includeBuildErrors;
			if (typeof p.includeTestResults === "boolean") args.includeTestResults = p.includeTestResults;
			if (typeof p.severity === "string") args.severity = p.severity;
			if (typeof p.testResultFilter === "string") args.testResultFilter = p.testResultFilter;
			if (typeof p.maxBuildErrors === "number") args.maxBuildErrors = p.maxBuildErrors;
			if (typeof p.maxTestResults === "number") args.maxTestResults = p.maxTestResults;

			return callTool(service, "diagnostics", args);
		},
	};
}

// ---------------------------------------------------------------------------
// Main export: create all wrapper tools
// ---------------------------------------------------------------------------

/**
 * Create all first-class Pi wrapper tool registrations for available IDE tools.
 * Builds TypeBox schemas using descriptions from stored MCP metadata.
 * Inherited param descriptions come exactly from MCP inputSchema.
 * New wrapper-only params (symbol, fileHint, etc.) have new descriptions.
 * Tool descriptions use MCP metadata; empty string if unavailable.
 * Returns an empty array if the service is not connected or missing required tools.
 */
export function createAllWrapperTools(service: JetBrainsService): ToolRegistration[] {
	const catalog = service.getCatalog();
	if (!catalog) return [];

	const tools: ToolRegistration[] = [];

	// Thin wrappers — register only when backend is available
	if (catalog.findFile) tools.push(createFindFile(service));
	if (catalog.searchText) tools.push(createSearchText(service));
	if (catalog.moveFile) tools.push(createMoveFile(service));
	if (catalog.fileStructure) tools.push(createFileStructure(service));

	// Merged symbol search
	if (catalog.findSymbol || catalog.findClass) {
		tools.push(createFindSymbol(service));
	}

	// Resolver-backed semantic tools
	if (catalog.findDefinition) tools.push(createDefinition(service));
	if (catalog.findReferences) tools.push(createReferences(service));
	if (catalog.rename) tools.push(createRename(service));
	if (catalog.findImplementations) tools.push(createImplementations(service));
	if (catalog.findSuperMethods) tools.push(createSuperMethods(service));
	if (catalog.typeHierarchy) tools.push(createTypeHierarchy(service));
	if (catalog.callHierarchy) tools.push(createCallHierarchy(service));

	// Unified diagnostics
	if (catalog.diagnostics) tools.push(createDiagnostics(service));

	return tools;
}
