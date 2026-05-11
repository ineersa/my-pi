/**
 * ide_rename_symbol — resolver-backed, mutation-locked wrapper for IDE symbol rename refactoring.
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { toToon, makeError } from "../response-formatting.js";
import { callTool, resolveAndMerge, TargetParams, withMutationLock } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createRenameSymbol(service: JetBrainsService): ToolRegistration {
	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Rename a symbol using the IDE semantic rename refactoring. Use this for classes, interfaces, "
		+ "traits, enums, methods, functions, fields, constants, variables, and similar code symbols. "
		+ "The IDE updates references/usages where supported by the language/plugin.\n\n"
		+ "Use this instead of search/replace or manual edits when changing a symbol name. "
		+ "Prefer file + line + column when you know the symbol occurrence or declaration location; "
		+ "this is the most reliable mode. Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "If symbol resolution finds multiple candidates, the tool returns a normalized error "
		+ "with a hint to provide fileHint or an exact file+line+column target.\n\n"
		+ "Returns the IDE rename result, including affected files/change counts when provided "
		+ "by the backend.\n\n"
		+ `Examples: {"file":"src/services/user-service.ts","line":42,"column":18,"newName":"createAccount"}, `
		+ `{"symbol":"App\\Service\\UserService::create","language":"php","kind":"method","newName":"createAccount"}, `
		+ `{"symbol":"load_config","language":"python","kind":"function","newName":"load_settings"}, `
		+ `{"symbol":"createUser","language":"typescript","kind":"function","fileHint":"src/users/create-user.ts","newName":"createAccount"}`;

	const params = Type.Object({
		...TargetParams,
		newName: Type.String({ description: "New symbol name to apply with IDE semantic rename." }),
	});

	return {
		name: "ide_rename_symbol",
		label: "Rename Symbol (IDE)",
		description: toolDescription,
		promptSnippet: "Rename a class, method, function, field, or variable with automatic reference updates via the IDE",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as Record<string, unknown>;
			const newName = p.newName;
			if (typeof newName !== "string" || !newName.trim()) {
				const payload = makeError("newName is required.", "Provide the new name for the symbol.", false);
				return { content: [{ type: "text", text: toToon(payload) }], isError: true };
			}
			const merged = await resolveAndMerge(service, p, ctx.cwd, { newName });
			if ("content" in merged) return merged as ToolResult;
			return withMutationLock(async () => {
				const result = await callTool(service, "rename", merged as Record<string, unknown>);
				if (!result.isError) {
					await service.syncProject();
					await service.waitForIndexReady();
				}
				return result;
			});
		},
	};
}
