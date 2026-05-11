/**
 * ide_type_hierarchy — resolver-backed wrapper for IDE type hierarchy.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createTypeHierarchy(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("typeHierarchy");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Show the IDE type hierarchy for a class, interface, trait, enum, or similar type symbol. "
		+ "Use this to understand inheritance/type relationships: "
		+ "base classes, implemented interfaces/traits, subclasses, and implementors.\n\n"
		+ "Prefer file + line + column when you know the type location; "
		+ "this is the most reliable mode. "
		+ "Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "This is a type hierarchy tool, not a reference search, call graph, "
		+ "or method override-chain lookup. "
		+ "Use ide_find_references for usages, ide_call_hierarchy for callers/callees, "
		+ "and ide_find_super_methods for overridden/implemented parent methods.\n\n"
		+ "Returns the target type, supertype chain, and subtype/implementation tree "
		+ "when provided by the IDE backend.\n\n"
		+ `Examples: {"file":"src/services/user-service.ts","line":12,"column":14}, `
		+ `{"symbol":"App\\Service\\UserService","language":"php","kind":"class"}, `
		+ `{"symbol":"BaseRepository","language":"typescript","kind":"class","fileHint":"src/repositories/base-repository.ts"}, `
		+ `{"symbol":"ConfigLoader","language":"python","kind":"class"}`;

	const params = Type.Object({
		...TargetParams,
		scope: Type.Optional(StringEnum(
			["project_files", "project_and_libraries", "project_production_files", "project_test_files"] as const,
			{ description: desc("scope") || "Search scope. Default: project_files." },
		) as any),
	});

	return {
		name: "ide_type_hierarchy",
		label: "Type Hierarchy (IDE)",
		description: toolDescription,
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
