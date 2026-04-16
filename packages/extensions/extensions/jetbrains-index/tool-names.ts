import {
	BUILTIN_GENERIC_TOOLS,
	GENERIC_SUFFIXES,
	SEARCH_BASH_REGEX,
	SYMBOLIC_SUFFIXES,
} from "./constants.js";

export function getToolSuffix(toolName: string): string {
	if (!toolName.includes("_")) {
		return toolName;
	}

	const parts = toolName.split("_");
	const maybeTwoPartSuffix = `${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
	if (SYMBOLIC_SUFFIXES.has(maybeTwoPartSuffix) || GENERIC_SUFFIXES.has(maybeTwoPartSuffix)) {
		return maybeTwoPartSuffix;
	}

	return parts[parts.length - 1] ?? toolName;
}

export function resolveEffectiveToolName(event: { toolName: string; input: Record<string, unknown> }): string {
	if (event.toolName !== "mcp") return event.toolName;

	const proxyTool = event.input?.tool;
	if (typeof proxyTool === "string" && proxyTool.trim().length > 0) {
		return proxyTool.trim();
	}

	return event.toolName;
}

export function isSymbolicTool(name: string): boolean {
	const suffix = getToolSuffix(name);
	return SYMBOLIC_SUFFIXES.has(suffix);
}

export function isGenericTool(name: string): boolean {
	if (BUILTIN_GENERIC_TOOLS.has(name)) return true;
	const suffix = getToolSuffix(name);
	return GENERIC_SUFFIXES.has(suffix);
}

export function getGenericIncrement(toolName: string, bashCommand: string): number {
	if (toolName === "read") return 2;
	if (toolName === "bash" && SEARCH_BASH_REGEX.test(bashCommand)) return 2;
	return 1;
}

export function describeGenericTool(toolName: string, bashCommand: string): string {
	if (toolName === "read") return "read";
	if (toolName === "bash" && SEARCH_BASH_REGEX.test(bashCommand)) {
		const trimmed = bashCommand.trim().replace(/\s+/g, " ");
		const preview = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
		return `bash (${preview})`;
	}
	return toolName;
}
