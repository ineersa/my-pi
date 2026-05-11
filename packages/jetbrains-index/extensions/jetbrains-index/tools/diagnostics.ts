/**
 * ide_diagnostics — file-only IDE diagnostics wrapper.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { callTool } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createDiagnostics(service: JetBrainsService): ToolRegistration {
	const params = Type.Object({
		file: Type.String({ description: "Project-relative file path to inspect for IDE diagnostics." }),
		level: Type.Optional(
			StringEnum(["all", "errors", "warnings"] as const, {
				description:
					"Diagnostic level filter. all returns all diagnostics; errors returns only errors; warnings returns warnings. Default: all.",
			}) as any,
		),
	});

	return {
		name: "ide_diagnostics",
		label: "Diagnostics (IDE)",
		description:
			"Get IDE diagnostics for a project-relative file. Use this after editing a file or when you need IDE-reported errors and warnings for a specific file.\n\nReturns diagnostics with level/severity, message, source/code, and line/column locations when provided by the IDE backend.\n\nExamples: {\"file\":\"src/services/user-service.ts\"}, {\"file\":\"app/Service/UserService.php\",\"level\":\"errors\"}, {\"file\":\"src/config/settings.py\",\"level\":\"warnings\"}",
		promptSnippet: "Get IDE diagnostics for a project-relative file",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const p = params as Record<string, unknown>;

			const file = typeof p.file === "string" ? p.file.trim() : "";
			if (!file) {
				const payload = service.makeError(
					"file is required and must be a non-empty string.",
					"Provide a valid project-relative file path.",
					false,
				);
				return { content: [{ type: "text", text: service.toToon(payload) }], isError: true };
			}

			// Best-effort open file in IDE
			await service.openFile(file);

			// Sync changed paths
			await service.syncFiles([file]);

			// Wait for index
			await service.waitForIndexReady();

			// Build args for diagnostics call
			const args: Record<string, unknown> = { file };
			if (typeof p.level === "string") {
				args.severity = p.level;
			}

			return callTool(service, "diagnostics", args);
		},
	};
}
