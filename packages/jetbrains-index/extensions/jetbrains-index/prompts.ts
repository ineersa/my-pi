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

/**
 * Build a move refactor reminder. No system-reminder wrapping.
 */
export function buildMoveRefactorReminder(activeTools: string[], commandPreview: string): string {
	const moveFile = resolveToolName(activeTools, [
		"jetbrains_index__ide_move_file",
		"ide_move_file",
	]);

	return [
		"Refactor Safety Reminder:",
		`- Detected shell move command: ${commandPreview}`,
		`- Prefer ${moveFile} for code file moves so imports/references are updated safely.`,
		"- Avoid mv/git mv for source files unless you intentionally do a raw filesystem move.",
	].join("\n");
}

/**
 * Build a diagnostics summary message. No system-reminder wrapping.
 */
export function buildNewDiagnosticsMessage(summary: string): string {
	return `The following new diagnostic issues were detected:\n\n${summary}`;
}
