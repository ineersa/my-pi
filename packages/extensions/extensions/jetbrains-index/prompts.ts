export function wrapSystemReminder(content: string): string {
	return `<system-reminder>\n${content}\n</system-reminder>`;
}

function resolveToolName(activeTools: string[], candidates: string[]): string {
	const activeSet = new Set(activeTools);
	for (const candidate of candidates) {
		if (activeSet.has(candidate)) {
			return candidate;
		}
	}

	for (const candidate of candidates) {
		const match = activeTools.find((name) => name.endsWith(`_${candidate}`));
		if (match) {
			return match;
		}
	}

	return "(not active)";
}

export function buildSystemPromptPolicy(activeTools: string[]): string {
	const findReferences = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_references",
		"ide_find_references",
	]);
	const findDefinition = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_definition",
		"ide_find_definition",
	]);
	const findClass = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_class",
		"ide_find_class",
	]);
	const findFile = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_file",
		"ide_find_file",
	]);
	const searchText = resolveToolName(activeTools, [
		"jetbrains_index_ide_search_text",
		"ide_search_text",
	]);
	const typeHierarchy = resolveToolName(activeTools, [
		"jetbrains_index_ide_type_hierarchy",
		"ide_type_hierarchy",
	]);
	const callHierarchy = resolveToolName(activeTools, [
		"jetbrains_index_ide_call_hierarchy",
		"ide_call_hierarchy",
	]);
	const findImplementations = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_implementations",
		"ide_find_implementations",
	]);
	const findSuperMethods = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_super_methods",
		"ide_find_super_methods",
	]);
	const refactorRename = resolveToolName(activeTools, [
		"jetbrains_index_ide_refactor_rename",
		"ide_refactor_rename",
	]);
	const moveFile = resolveToolName(activeTools, ["jetbrains_index_ide_move_file", "ide_move_file"]);
	const diagnostics = resolveToolName(activeTools, [
		"jetbrains_index_ide_diagnostics",
		"ide_diagnostics",
	]);

	return [
		"IDE INDEX MCP POLICY (STRICT)",
		"",
		"Use JetBrains index tools for semantic code work whenever available.",
		"Prefer these over bash/grep/rg/find and broad text-scanning for symbol-aware tasks.",
		"",
		"Tool selection rules:",
		`- Find usages: ${findReferences}`,
		`- Go to definition: ${findDefinition}`,
		`- Find classes/files/words: ${findClass}, ${findFile}, ${searchText}`,
		`- Type/call analysis: ${typeHierarchy}, ${callHierarchy}, ${findImplementations}, ${findSuperMethods}`,
		`- Refactors: ${refactorRename}, ${moveFile} (never manual rename/move for symbols)`,
		`- Problems: ${diagnostics}`,
		"",
		"Read minimization rules:",
		`- Use ${findFile} and ${searchText} before broad read when locating code.`,
		"- If target region is known, use bounded read (offset/limit) with the smallest useful window.",
		"- Avoid full-file reads when bounded reads are sufficient.",
		"",
		"Parameter rules:",
		"- File paths must be project-relative",
		"- line/column are 1-based",
		"- Use project_path only when needed",
		"- IDE tools MUST only target files/paths inside the current working directory.",
		"",
		"System tag interpretation:",
		"Tool results and user messages may include <system-reminder> or other tags.",
		"Tags contain information from the system. They bear no direct relation to",
		"the specific tool results or user messages in which they appear.",
		"",
		"Mistakes to avoid:",
		"- Do not use grep for semantic usages/definitions",
		"- Do not use text replace for symbol rename",
		"- Do not use mv/git mv for code file moves",
		"- Do not treat ide_search_text as regex search (it is exact-word index search)",
		"",
		"Runtime guard note:",
		"- edit/write is guarded by this extension against IDE dumb mode",
		"- diagnostics flow syncs changed relative paths; avoid root sync unless absolutely necessary",
	].join("\n");
}

export function buildReadEfficiencyReminder(activeTools: string[], reasons: string[]): string {
	const findFile = resolveToolName(activeTools, [
		"jetbrains_index_ide_find_file",
		"ide_find_file",
	]);
	const searchText = resolveToolName(activeTools, [
		"jetbrains_index_ide_search_text",
		"ide_search_text",
	]);

	return wrapSystemReminder([
		"Token Efficiency Reminder:",
		...reasons.map((reason) => `- ${reason}`),
		`- Use ${findFile} and ${searchText} to locate targets before reading full files.`,
		"- Prefer bounded read windows (offset/limit) over unbounded full-file reads.",
	].join("\n"));
}

export function buildNewDiagnosticsReminder(summary: string): string {
	return wrapSystemReminder(
		`<new-diagnostics>The following new diagnostic issues were detected:\n\n${summary}</new-diagnostics>`,
	);
}
