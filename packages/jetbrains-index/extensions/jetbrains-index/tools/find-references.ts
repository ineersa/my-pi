/**
 * ide_find_references — resolver-backed wrapper for IDE reference search.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createReferences(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findReferences");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Find usages/references of a symbol using the IDE index. "
		+ "Use this for impact analysis before renaming, deleting, changing API behavior/signatures, "
		+ "or when you need to understand how a symbol is used.\n\n"
		+ "Prefer file + line + column when you know the reference/definition location; "
		+ "this is the most reliable mode. "
		+ "Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "If symbol resolution finds multiple candidates, the tool returns a normalized error "
		+ "with a hint to provide fileHint or an exact file+line+column target.\n\n"
		+ "Returns referencing files, line/column locations, context snippets, "
		+ "and reference type/classification when provided by the IDE backend.\n\n"
		+ "Supports pagination: first call returns results + nextCursor. "
		+ "Pass cursor to get the next page; cursor-only calls continue pagination "
		+ "without requiring a target.\n\n"
		+ `Examples: {"file":"src/services/user-service.ts","line":42,"column":18}, `
		+ `{"symbol":"App\\Service\\UserService::create","language":"php","kind":"method","pageSize":100}, `
		+ `{"symbol":"load_config","language":"python","kind":"function"}, `
		+ `{"symbol":"createUser","language":"typescript","kind":"function","fileHint":"src/users/create-user.ts"}`;

	const params = Type.Object({
		...TargetParams,
		scope: Type.Optional(StringEnum(
			["project_files", "project_and_libraries", "project_production_files", "project_test_files"] as const,
			{ description: desc("scope") || "Search scope. Default: project_files." },
		) as any),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_references",
		label: "Find References (IDE)",
		description: toolDescription,
		promptSnippet: "Impact analysis: find all usages/references before changing or judging a symbol.",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const toolArgs: Record<string, unknown> = {};
			if (typeof p.scope === "string") toolArgs.scope = p.scope;
			if (typeof p.pageSize === "number") toolArgs.pageSize = p.pageSize;
			if (typeof p.cursor === "string") toolArgs.cursor = p.cursor;

			// Cursor-only mode — bypass target resolution and paginate directly
			const hasFullLocation = typeof p.file === "string" && typeof p.line === "number" && typeof p.column === "number";
			const hasSymbol = typeof p.symbol === "string" && p.symbol.length > 0;
			if (typeof p.cursor === "string" && !hasFullLocation && !hasSymbol) {
				return callTool(service, "findReferences", toolArgs);
			}

			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findReferences", merged as Record<string, unknown>);
		},
	};
}
