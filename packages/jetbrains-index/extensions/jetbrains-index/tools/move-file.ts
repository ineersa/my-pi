/**
 * ide_move_file — mutation-locked thin passthrough wrapper for IDE move refactoring.
 * Public param is destination (maps to backend newFile).
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { callTool, withMutationLock } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createMoveFile(service: JetBrainsService): ToolRegistration {
	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Move/relocate a file using IDE refactoring. "
		+ "The IDE updates imports, usages, references, and package/namespace information after the move.\n\n"
		+ "Use this instead of mv, git mv, or manual file relocation when moving code or project files. "
		+ "Provide the existing project-relative file path and the destination directory. "
		+ "The original file name is preserved. "
		+ "Use ide_rename_file to change a file name without moving it. "
		+ "Use ide_rename_symbol to rename classes, methods, functions, fields, or other code symbols.\n\n"
		+ "Returns the IDE move result, including affected files/change counts when provided by the backend.\n\n"
		+ 'Examples: {"file":"src/services/user-service.ts","destination":"src/domain/users"}, '
		+ '{"file":"app/Service/UserService.php","destination":"app/Domain/User"}, '
		+ '{"file":"src/config/settings.py","destination":"src/app/config"}';

	const params = Type.Object({
		file: Type.String({ description: "Existing project-relative file path to move." }),
		destination: Type.String({
			description:
				"Destination directory path, project-relative. "
				+ "The original file name is preserved; use ide_rename_file to change the file name.",
		}),
	});

	return {
		name: "ide_move_file",
		label: "Move File (IDE)",
		description: toolDescription,
		promptSnippet: "Move/relocate a file with automatic import/reference updates",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const p = params as { file: string; destination: string };
			if (typeof p.file !== "string" || !p.file.trim()) {
				const payload = service.makeError(
					"file is required.",
					"Provide the project-relative file path to move.",
					false,
				);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}
			if (typeof p.destination !== "string" || !p.destination.trim()) {
				const payload = service.makeError(
					"destination is required.",
					"Provide the destination directory path.",
					false,
				);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}
			const backendArgs = { file: p.file, destination: p.destination };
			return withMutationLock(async () => {
				const result = await callTool(service, "moveFile", backendArgs);
				if (!result.isError) {
					await service.syncProject();
					await service.waitForIndexReady();
				}
				return result;
			});
		},
	};
}
