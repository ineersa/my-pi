/**
 * Shared helpers and constants for first-class Pi wrapper tools.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService, type JetBrainsToolKey, type MCPToolDefinition } from "../jetbrains-service.js";
import { resolveTarget, type TargetInput } from "../target-resolver.js";
import { toToon, makeError, isMcpError, getMcpErrorText, decodeMcpPayload } from "../response-formatting.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared IDE tool prompt guidelines
// ---------------------------------------------------------------------------

/**
 * Shared prompt guidelines appended to the system prompt Guidelines section
 * when any first-class IDE wrapper tool is active.
 * Pi deduplicates identical guidelines, so it is safe to attach to every tool.
 *
 * Wording uses "IDE tools" (not "JetBrains tools") per user preference.
 * The unavailable/index guideline is intentionally absent — the extension
 * handles blocking and aborting when the IDE/index is unavailable.
 */
export const IDE_PROMPT_GUIDELINES: readonly string[] = [
	"Prefer IDE tools over bash/rg/find for code navigation and semantic operations in the current working directory.",
	"Use ide_find_file, ide_find_symbol, ide_search_text, and ide_file_structure before broad filesystem reads or shell searches.",

	"Before answering code review, architecture, refactor-risk, or impact-analysis questions, gather IDE evidence instead of relying only on file reads.",
	"Use ide_find_references before judging whether a symbol/API/function/class is safe to change or remove.",
	"Use ide_call_hierarchy with direction:\"callers\" for blast radius and direction:\"callees\" for implementation internals when reviewing functions or methods.",
	"Use ide_type_hierarchy and ide_find_implementations when reviewing classes, interfaces, inheritance, abstractions, or architecture.",
	"Use ide_find_super_methods when reviewing overridden methods or interface/abstract method implementations.",

	"Use ide_rename_symbol for renaming classes, methods, functions, fields, variables, and properties instead of raw edits or search/replace.",
	"Use ide_rename_file and ide_move_file instead of mv/git mv for source files so imports, usages, references, and package/namespace information are updated.",
	"IDE tools are only available for targets inside the current working directory.",
] as const;

/**
 * Attach the shared IDE prompt guidelines to a tool registration.
 * Use in the barrel (wrappers.ts) to avoid editing 14 tool files individually.
 */
export function withIdePromptGuidelines<T extends { promptGuidelines?: string[] }>(tool: T): T {
	return {
		...tool,
		promptGuidelines: [...IDE_PROMPT_GUIDELINES],
	};
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Get a parameter description from the stored MCP inputSchema metadata.
 * Returns the original MCP description, or empty string if unavailable.
 * Never invents a fallback description.
 */
export function getParamDesc(meta: MCPToolDefinition | null, paramName: string): string {
	const props = meta?.inputSchema?.properties as Record<string, { description?: string }> | undefined;
	const d = props?.[paramName]?.description;
	return typeof d === "string" ? d : "";
}

/**
 * Get the tool description from stored MCP metadata.
 * Returns the original MCP description, or empty string if unavailable.
 * No fallback — if the MCP server didn't provide a description, we don't invent one.
 */
export function getToolDesc(meta: MCPToolDefinition | null): string {
	return meta?.description ?? "";
}

// ---------------------------------------------------------------------------
// Toolkit error helpers
// ---------------------------------------------------------------------------

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
export async function callTool(
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
			const payload = makeError(call.error ?? "Tool call failed", hint, isRetryable);
			return { content: [{ type: "text", text: toToon(payload) }], isError: true };
		}

		// MCP-level error (backend returned isError: true, e.g. "No class/type found")
		if (isMcpError(call.result)) {
			const errorText = getMcpErrorText(call.result) ?? "IDE tool returned an error";
			const payload = makeError(errorText, hint, isRetryable);
			return { content: [{ type: "text", text: toToon(payload) }], isError: true };
		}

		// Success: decode the actual data payload from MCP content blocks
		const payload = decodeMcpPayload(call.result);
		return { content: [{ type: "text", text: toToon(payload) }] };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const payload = makeError(msg, hint, isRetryable);
		return { content: [{ type: "text", text: toToon(payload) }], isError: true };
	}
}

/**
 * Resolve a target (symbol or location) and return canonical `{ file, line, column }`
 * plus any tool-specific args merged in. If resolution fails, return an error ToolResult.
 */
export async function resolveAndMerge(
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
		const payload = makeError(
			"Provide file+line+column, or symbol.",
			"Use file+line+column when known; otherwise provide symbol.",
			false,
		);
		return { content: [{ type: "text", text: toToon(payload) }], isError: true };
	}

	if (hasFullLocation) {
		const resolved = await resolveTarget(targetInput, service, cwd);
		if (resolved.status === "ok") {
			return { ...toolArgs, file: resolved.file, line: resolved.line, column: resolved.column };
		}
		return resolveErrorToResult(resolved);
	}

	// Symbol mode
	const resolved = await resolveTarget(targetInput, service, cwd);
	if (resolved.status === "ok") {
		return { ...toolArgs, file: resolved.file, line: resolved.line, column: resolved.column };
	}
	return resolveErrorToResult(resolved);
}

function resolveErrorToResult(
	result: { status: string; summary: string; hint?: string },
): ToolResult {
	const payload = makeError(
		result.summary,
		result.hint ?? "Try file+line+column targeting instead.",
		false,
	);
	return { content: [{ type: "text", text: toToon(payload) }], isError: true };
}

// ---------------------------------------------------------------------------
// Mutation lock — shared between rename and move_file
// ---------------------------------------------------------------------------

let mutationLock: Promise<void> = Promise.resolve();

export function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = mutationLock;
	let release: () => void;
	mutationLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	return prev.then(() => fn().finally(() => release!()));
}

// ---------------------------------------------------------------------------
// File structure lock — serializes parallel ide_file_structure calls
// Separate from mutation lock to avoid unnecessary blocking.
// ---------------------------------------------------------------------------

let fileStructureLock: Promise<void> = Promise.resolve();

/**
 * Serialize parallel ide_file_structure calls through a private queue.
 * Does NOT share the mutation lock — file structure is a read-only tool.
 */
export function withFileStructureLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = fileStructureLock;
	let release: () => void;
	fileStructureLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	return prev.then(() => fn().finally(() => release!()));
}

// ---------------------------------------------------------------------------
// Shared targeting params (wrapper-only, NOT from MCP metadata)
// ---------------------------------------------------------------------------

export const kindEnum = StringEnum(
	["class", "interface", "trait", "enum", "method", "function", "field", "constant"] as const,
	{ description: "Symbol kind hint for narrowing resolution and reducing ambiguity." },
);

export const TargetParams = {
	file: Type.Optional(Type.String({ description: "Project-relative file path for location mode. Use with line and column; preferred when you know the exact reference location." })),
	line: Type.Optional(Type.Number({ description: "1-based line number for location mode. Required with file and column." })),
	column: Type.Optional(Type.Number({ description: "1-based column number for location mode. Required with file and line." })),
	symbol: Type.Optional(Type.String({ description: "Symbol to resolve when location is unknown. Can be qualified per language convention, e.g. PHP `App\\Service\\UserService::create`, Python `package.module:function`, or JS/TS symbol name with fileHint." })),
	language: Type.Optional(Type.String({ description: "Language hint for symbol resolution: php, python, typescript, javascript, rust, go. Helps reduce ambiguity." })),
	kind: Type.Optional(kindEnum as any),
	fileHint: Type.Optional(Type.String({ description: "Project-relative file path hint for symbol resolution. Strongly recommended for JavaScript/TypeScript; also useful for Go or any ambiguous bare symbol." })),
};
