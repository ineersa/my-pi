/**
 * Barrell/orchestrator for first-class Pi wrapper tools.
 *
 * This file imports all per-tool factory functions from the tools/ directory
 * and re-exports the unified registration function `createAllWrapperTools`.
 *
 * Each tool lives in its own file under tools/:
 *   tools/types.ts            — shared type definitions
 *   tools/shared.ts           — shared helpers (callTool, resolveAndMerge, withMutationLock, etc.)
 *   tools/find-file.ts        — ide_find_file
 *   tools/search-text.ts      — ide_search_text
 *   tools/find-symbol.ts      — ide_find_symbol
 *   tools/find-references.ts  — ide_find_references
 *   tools/rename-symbol.ts    — ide_rename_symbol
 *   tools/rename-file.ts      — ide_rename_file
 *   tools/find-implementations.ts — ide_find_implementations
 *   tools/find-super-methods.ts   — ide_find_super_methods
 *   tools/type-hierarchy.ts   — ide_type_hierarchy
 *   tools/call-hierarchy.ts   — ide_call_hierarchy
 *   tools/diagnostics.ts      — ide_diagnostics
 *   tools/move-file.ts        — ide_move_file
 *   tools/file-structure.ts   — ide_file_structure
 */
import { JetBrainsService } from "./jetbrains-service.js";
import { createFindFile } from "./tools/find-file.js";
import { createSearchText } from "./tools/search-text.js";
import { createFindSymbol } from "./tools/find-symbol.js";
import { createReferences } from "./tools/find-references.js";
import { createRenameSymbol } from "./tools/rename-symbol.js";
import { createRenameFile } from "./tools/rename-file.js";
import { createImplementations } from "./tools/find-implementations.js";
import { createSuperMethods } from "./tools/find-super-methods.js";
import { createTypeHierarchy } from "./tools/type-hierarchy.js";
import { createCallHierarchy } from "./tools/call-hierarchy.js";
import { createDiagnostics } from "./tools/diagnostics.js";
import { createMoveFile } from "./tools/move-file.js";
import { createFileStructure } from "./tools/file-structure.js";
import type { ToolRegistration } from "./tools/types.js";
import { withIdePromptGuidelines } from "./tools/shared.js";

/**
 * Create all first-class Pi wrapper tool registrations for available IDE tools.
 *
 * Builds TypeBox schemas using descriptions from stored MCP metadata.
 * Inherited param descriptions come exactly from MCP inputSchema.
 * New wrapper-only params (symbol, fileHint, etc.) have new descriptions.
 * Tool descriptions use MCP metadata; empty string if unavailable.
 *
 * Returns an empty array if the service is not connected or missing required tools.
 */
export function createAllWrapperTools(service: JetBrainsService): ToolRegistration[] {
	const catalog = service.getCatalog();
	if (!catalog) return [];

	const tools: ToolRegistration[] = [];

	// Thin wrappers — register only when backend is available
	if (catalog.findFile) tools.push(createFindFile(service));
	if (catalog.searchText) tools.push(createSearchText(service));
	if (catalog.moveFile) tools.push(createMoveFile(service));
	if (catalog.fileStructure) tools.push(createFileStructure(service));

	// Merged symbol search
	if (catalog.findSymbol || catalog.findClass) {
		tools.push(createFindSymbol(service));
	}

	// Resolver-backed semantic tools
	if (catalog.findReferences) tools.push(createReferences(service));
	if (catalog.rename) {
		tools.push(createRenameSymbol(service));
		tools.push(createRenameFile(service));
	}
	if (catalog.findImplementations) tools.push(createImplementations(service));
	if (catalog.findSuperMethods) tools.push(createSuperMethods(service));
	if (catalog.typeHierarchy) tools.push(createTypeHierarchy(service));
	if (catalog.callHierarchy) tools.push(createCallHierarchy(service));

	// Unified diagnostics
	if (catalog.diagnostics) tools.push(createDiagnostics(service));

	return tools.map(withIdePromptGuidelines);
}
