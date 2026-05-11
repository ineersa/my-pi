/**
 * ide_search_text — thin passthrough wrapper for indexed text search.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, getToolDesc, callTool } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createSearchText(service: JetBrainsService): ToolRegistration {
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
