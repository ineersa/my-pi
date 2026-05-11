/**
 * ide_find_implementations — resolver-backed wrapper for IDE implementation search.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createImplementations(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findImplementations");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Find implementations of an interface, abstract/base class, trait/protocol, or abstract/interface method "
		+ "using the IDE index. Use this to discover concrete classes or methods that implement or override "
		+ "an abstraction.\n\n"
		+ "Prefer file + line + column when you know the abstraction location; "
		+ "this is the most reliable mode. "
		+ "Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "This is an implementation search, not a full type hierarchy, reference search, call graph, "
		+ "or parent-method lookup. "
		+ "Use ide_type_hierarchy for inheritance trees, ide_find_references for usages, "
		+ "ide_call_hierarchy for callers/callees, and ide_find_super_methods for overridden/implemented "
		+ "parent methods.\n\n"
		+ "Returns implementing classes/methods with file, line/column, kind, and related metadata "
		+ "when provided by the IDE backend.\n\n"
		+ "Supports pagination: first call returns results + nextCursor. "
		+ "Pass cursor to get the next page; cursor-only calls continue pagination "
		+ "without requiring a target.\n\n"
		+ `Examples: {"file":"src/contracts/user-repository.ts","line":8,"column":18}, `
		+ `{"symbol":"App\\Contracts\\UserRepositoryInterface","language":"php","kind":"interface"}, `
		+ `{"symbol":"BaseRepository","language":"typescript","kind":"class","fileHint":"src/repositories/base-repository.ts"}, `
		+ `{"symbol":"ConfigLoader","language":"python","kind":"class","pageSize":50}`;

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
		name: "ide_find_implementations",
		label: "Find Implementations (IDE)",
		description: toolDescription,
		promptSnippet: "Find concrete implementations of interfaces, abstract classes, traits, or abstract methods.",
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
				return callTool(service, "findImplementations", toolArgs);
			}

			const merged = await resolveAndMerge(service, p, ctx.cwd, toolArgs);
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findImplementations", merged as Record<string, unknown>);
		},
	};
}
