/**
 * ide_call_hierarchy — resolver-backed wrapper for IDE call hierarchy.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createCallHierarchy(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("callHierarchy");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Build the IDE call hierarchy for a function or method. "
		+ "Use direction:\"callers\" to find functions/methods that call the target; "
		+ "this is usually the right direction for blast radius or impact analysis "
		+ "before changing a function/method. "
		+ "Use direction:\"callees\" to find functions/methods called by the target; "
		+ "this is useful for understanding implementation internals. "
		+ "If you need both directions, call the tool twice.\n\n"
		+ "Prefer file + line + column when you know the function/method location; "
		+ "this is the most reliable mode. "
		+ "Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "This is a call graph tool, not a general reference search, type hierarchy, "
		+ "implementation search, or super-method lookup. "
		+ "Use ide_find_references for all usages, ide_type_hierarchy for inheritance trees, "
		+ "ide_find_implementations for concrete implementations, "
		+ "and ide_find_super_methods for parent overridden/implemented methods.\n\n"
		+ "Returns a recursive hierarchy tree with function/method signatures, "
		+ "file/line/column locations, and nested caller/callee relationships "
		+ "when provided by the IDE backend.\n\n"
		+ `Examples: {"file":"src/services/user-service.ts","line":42,"column":18,"direction":"callers","depth":2}, `
		+ `{"symbol":"App\\Service\\UserService::create","language":"php","kind":"method","direction":"callees","depth":3}, `
		+ `{"symbol":"load_config","language":"python","kind":"function","direction":"callers"}, `
		+ `{"symbol":"createUser","language":"typescript","kind":"function","fileHint":"src/users/create-user.ts","direction":"callees","depth":2}`;

	const params = Type.Object({
		...TargetParams,
		direction: StringEnum(["callers", "callees"] as const, {
			description: "Call hierarchy direction. callers finds functions/methods that call the target; callees finds functions/methods called by the target. Use callers for blast radius/impact analysis; use callees to understand internals.",
		}) as any,
		depth: Type.Optional(Type.Number({
			description: "How many call hierarchy levels to traverse. Default: 3, max: 5.",
		})),
		scope: Type.Optional(StringEnum(
			["project_files", "project_and_libraries", "project_production_files", "project_test_files"] as const,
			{ description: desc("scope") || "Search scope. Default: project_files." },
		) as any),
	});

	return {
		name: "ide_call_hierarchy",
		label: "Call Hierarchy (IDE)",
		description: toolDescription,
		promptSnippet: "Trace callers/callees for code review, blast radius, and implementation internals.",
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
