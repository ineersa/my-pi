/**
 * ide_find_super_methods — resolver-backed wrapper for IDE super-method search.
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { getToolDesc, callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createSuperMethods(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findSuperMethods");

	const params = Type.Object({
		...TargetParams,
	});

	return {
		name: "ide_find_super_methods",
		label: "Find Super Methods (IDE)",
		description: getToolDesc(meta),
		promptSnippet: "Find parent overridden/implemented methods for override/interface analysis.",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const merged = await resolveAndMerge(service, params as Record<string, unknown>, ctx.cwd, {});
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findSuperMethods", merged as Record<string, unknown>);
		},
	};
}
