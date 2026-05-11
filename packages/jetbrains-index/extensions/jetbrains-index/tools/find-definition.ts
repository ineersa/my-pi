/**
 * ide_find_definition — resolver-backed wrapper for IDE definition lookup.
 *
 * Tool description is curated (overrides MCP metadata).
 * Shared target params (file, line, column, symbol, language, kind, fileHint)
 * come from TargetParams in shared.ts.
 */
import { Type } from "@sinclair/typebox";
import { JetBrainsService } from "../jetbrains-service.js";
import { callTool, resolveAndMerge, TargetParams } from "./shared.js";
import type { ToolResult, ToolRegistration } from "./types.js";

export function createDefinition(service: JetBrainsService): ToolRegistration {
	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Resolve the definition/declaration of a symbol reference using the IDE index. "
		+ "Use this when you have a usage/reference and need to jump to where it is declared.\n\n"
		+ "Prefer file + line + column when you know the reference location; "
		+ "this is the most reliable mode. "
		+ "Use symbol mode when the location is unknown: provide symbol, "
		+ "and add language/kind to reduce ambiguity. "
		+ "For JavaScript/TypeScript symbol mode, strongly prefer fileHint.\n\n"
		+ "If symbol resolution finds multiple candidates, the tool returns a normalized error "
		+ "with a hint to provide fileHint or an exact file+line+column target.\n\n"
		+ "Returns the definition file, line/column, preview/context, symbol name, "
		+ "and AST path when provided by the IDE backend.\n\n"
		+ `Examples: {"file":"src/services/user-service.ts","line":42,"column":18}, `
		+ `{"symbol":"App\\Service\\UserService::create","language":"php","kind":"method"}, `
		+ `{"symbol":"load_config","language":"python","kind":"function"}, `
		+ `{"symbol":"createUser","language":"typescript","kind":"function","fileHint":"src/users/create-user.ts"}`;

	const params = Type.Object({
		...TargetParams,
	});

	return {
		name: "ide_find_definition",
		label: "Find Definition (IDE)",
		description: toolDescription,
		promptSnippet: "Jump to symbol definition via the IDE index",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const merged = await resolveAndMerge(service, params as Record<string, unknown>, ctx.cwd, {});
			if ("content" in merged) return merged as ToolResult;
			return callTool(service, "findDefinition", merged as Record<string, unknown>);
		},
	};
}
