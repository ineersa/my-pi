/**
 * ide_rename_file — mutation-locked wrapper for IDE file rename refactoring.
 *
 * Calls the backend rename tool with { file, newName } (no line/column — pure file rename).
 * Not resolver-backed: uses provided file path directly.
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { callTool, withMutationLock } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createRenameFile(service: JetBrainsService): ToolRegistration {
	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Rename a file using the IDE rename refactoring. The IDE updates imports/references/resource "
		+ "usages where supported by the language/plugin.\n\n"
		+ "Use this instead of mv/git mv/manual file renames when you want IDE-aware reference updates. "
		+ "Provide the existing project-relative file path and the new file name. "
		+ "For moving a file to another directory, use ide_move_file instead. "
		+ "For renaming classes, methods, functions, fields, or other code symbols, use ide_rename_symbol instead.\n\n"
		+ "Returns the IDE rename result, including affected files/change counts when provided "
		+ "by the backend.\n\n"
		+ `Examples: {"file":"src/services/old-user-service.ts","newName":"user-service.ts"}, `
		+ `{"file":"app/Service/OldUserService.php","newName":"UserService.php"}, `
		+ `{"file":"src/config/old_config.py","newName":"config.py"}`;

	const params = Type.Object({
		file: Type.String({ description: "Existing project-relative file path to rename." }),
		newName: Type.String({ description: "New file name, not a destination path. Use ide_move_file to move between directories." }),
	});

	return {
		name: "ide_rename_file",
		label: "Rename File (IDE)",
		description: toolDescription,
		promptSnippet: "Rename a file in place with automatic import/reference updates via the IDE",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const p = params as Record<string, unknown>;
			if (typeof p.file !== "string" || !p.file.trim()) {
				const payload = service.makeError("file is required.", "Provide the existing project-relative file path.", false);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}
			if (typeof p.newName !== "string" || !p.newName.trim()) {
				const payload = service.makeError("newName is required.", "Provide the new file name.", false);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}
			return withMutationLock(async () => {
				const result = await callTool(service, "rename", { file: p.file, newName: p.newName });
				if (!result.isError) {
					await service.syncProject();
					await service.waitForIndexReady();
				}
				return result;
			});
		},
	};
}
