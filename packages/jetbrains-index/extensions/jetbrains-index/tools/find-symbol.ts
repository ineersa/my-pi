/**
 * ide_find_symbol — merged symbol search (findSymbol with findClass fallback).
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { JetBrainsService } from "../jetbrains-service.js";
import { toToon, makeError } from "../response-formatting.js";
import { getParamDesc, callTool } from "./shared.js";
import type { ToolRegistration } from "./types.js";

export function createFindSymbol(service: JetBrainsService): ToolRegistration {
	const meta = service.getToolMetadata("findSymbol");
	const desc = (k: string) => getParamDesc(meta, k);

	// Curated tool description — overrides MCP metadata.
	const toolDescription =
		"Search for symbols by name using the IDE index, similar to IntelliJ Go to Symbol. "
		+ "This is semantic symbol lookup, not text search.\n\n"
		+ "Finds classes, interfaces, enums, traits, methods, functions, fields, and constants. "
		+ "Use kind to reduce noise when you know what kind of symbol you need. "
		+ "Use language in multi-language repositories.\n\n"
		+ "Matching follows IntelliJ Go to Symbol ranking, including short names and "
		+ "qualified-ish queries where supported by the IDE and language.\n\n"
		+ "Degraded mode: if findSymbol is unavailable, this wrapper falls back to class-only "
		+ "search via findClass; methods, functions, fields, and constants require findSymbol.\n\n"
		+ "Supports pagination: first call returns results + nextCursor. Pass cursor to get the next page.\n\n"
		+ `Examples: {"query":"UserService","kind":"class","language":"php"}, `
		+ `{"query":"createUser","kind":"function","language":"typescript"}, `
		+ `{"query":"load_config","kind":"function","language":"python"}`;

	const params = Type.Object({
		query: Type.String({ description: desc("query") }),
		kind: Type.Optional(StringEnum(
			["class", "interface", "trait", "enum", "method", "function", "field", "constant"] as const,
			{ description: desc("kind") },
		) as any),
		language: Type.Optional(Type.String({ description: desc("language") })),
		scope: Type.Optional(StringEnum(
			["project_files", "project_and_libraries", "project_production_files", "project_test_files"] as const,
			{ description: desc("scope") || "Search scope. Default: project_files." },
		) as any),
		pageSize: Type.Optional(Type.Number({ description: desc("pageSize") })),
		cursor: Type.Optional(Type.String({ description: desc("cursor") })),
	});

	return {
		name: "ide_find_symbol",
		label: "Find Symbol (IDE)",
		description: toolDescription,
		promptSnippet: "Fast indexed symbol search across the project with optional kind/language filters",
		parameters: params,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const args = params as Record<string, unknown>;

			// If findSymbol is available, use it
			const catalog = service.getCatalog();
			if (catalog?.findSymbol) {
				const query: Record<string, unknown> = { query: args.query };
				if (typeof args.kind === "string") query.kind = args.kind;
				if (typeof args.language === "string") query.language = args.language;
				if (typeof args.scope === "string") query.scope = args.scope;
				if (typeof args.pageSize === "number") query.pageSize = args.pageSize;
				if (typeof args.cursor === "string") query.cursor = args.cursor;
				return callTool(service, "findSymbol", query);
			}

			// Fallback to findClass for class-like queries
			if (catalog?.findClass) {
				const query: Record<string, unknown> = { query: args.query };
				if (typeof args.pageSize === "number") query.pageSize = args.pageSize;
				if (typeof args.cursor === "string") query.cursor = args.cursor;
				return callTool(service, "findClass", query);
			}

			const payload = makeError(
				"No symbol search backend available.",
				"Enable findSymbol or findClass in the JetBrains IDE plugin.",
				false,
			);
			return { content: [{ type: "text", text: toToon(payload) }], isError: true };
		},
	};
}
