/**
 * ide_file_structure — thin passthrough wrapper for IDE file structure view.
 *
 * Description and param descriptions are curated (not from MCP metadata).
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { callTool } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createFileStructure(service: JetBrainsService): ToolRegistration {
	const params = Type.Object({
		file: Type.String({ description: "Project-relative file path to inspect." }),
	});

	const toolDescription =
		"Show the IDE Structure-view outline for a single project file. "
		+ "Use this to understand a file's classes, interfaces, traits, enums, functions, "
		+ "methods, fields/constants, exports, Markdown headings, and nesting before "
		+ "reading or editing the file.\n\n"
		+ "This is a file outline tool, not a reference search or definition lookup. "
		+ "Use ide_find_references for usages.\n\n"
		+ "Returns a formatted structure tree with symbol names, kinds, signatures, "
		+ "nesting, and line numbers when provided by the IDE backend.\n\n"
		+ "Examples: "
		+ `{"file":"src/services/user-service.ts"}, `
		+ `{"file":"app/Service/UserService.php"}, `
		+ `{"file":"src/config/settings.py"}`;

	return {
		name: "ide_file_structure",
		label: "File Structure (IDE)",
		description: toolDescription,
		promptSnippet: "Show IDE file structure overview with symbols, nesting, and line numbers",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return callTool(service, "fileStructure", params as Record<string, unknown>);
		},
	};
}
