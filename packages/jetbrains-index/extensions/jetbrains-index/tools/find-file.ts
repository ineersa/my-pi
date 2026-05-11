/**
 * ide_find_file — thin passthrough wrapper for IDE file search.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { getParamDesc, getToolDesc, callTool } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createFindFile(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findFile");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata for improved clarity
	// and non-Java examples (PHP, JS/TS, Python).
	const toolDescription =
		"Search for files by name. Very fast file lookup using the IDE file index.\n\n"
		+ "Matching: uppercase/camel-hump (`USC` → `UserServiceController.php`), "
		+ "substring (`config` → `app.config.ts`), wildcard (`*Test.py`), and fuzzy matching.\n\n"
		+ "Returns matching files with name, path, and containing directory.\n\n"
		+ "Supports pagination: first call returns results + nextCursor. Pass cursor to get the next page.\n\n"
		+ `Examples: {"query":"UserService.php"}, {"query":"app.config.ts"}, {"query":"*test_*.py"}, {"query":"USC"}`;

	// Curated query parameter description — overrides MCP metadata.
	const queryDescription =
		"File name pattern. Supports uppercase/camel-hump, substring, wildcard, and fuzzy matching. "
		+ "Required for fresh search, ignored when cursor is provided.";

	const params = Type.Object({
		query: Type.String({ description: queryDescription }),
		scope: Type.Optional(StringEnum(
			["project_files", "project_and_libraries", "project_production_files", "project_test_files"] as const,
			{ description: desc("scope") || "Search scope. Default: project_files." },
		) as any),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_file",
		label: "Find File (IDE)",
		description: toolDescription,
		promptSnippet: "Fast indexed file search by name with uppercase/camel-hump, substring, wildcard, and fuzzy matching",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return callTool(service, "findFile", params as Record<string, unknown>);
		},
	};
}
