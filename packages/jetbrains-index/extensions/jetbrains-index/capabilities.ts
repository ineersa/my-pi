import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ToolCapabilities } from "./types.js";

function hasToolEnding(activeTools: string[], suffix: string): boolean {
	return activeTools.some((name) => name === suffix || name.endsWith(`_${suffix}`));
}

export function getToolCapabilities(pi: ExtensionAPI): ToolCapabilities {
	const activeTools = pi.getActiveTools();
	const hasMcp = activeTools.includes("mcp");
	const hasDirectJetBrains = activeTools.some((name) =>
		name.startsWith("jetbrains_") || name.startsWith("phpstorm_"),
	);

	return {
		hasMcp,
		proxyOnly: hasMcp && !hasDirectJetBrains,
		hasSearchSymbol: hasToolEnding(activeTools, "search_symbol"),
		hasSymbolInfo: hasToolEnding(activeTools, "get_symbol_info"),
		hasStructuralSearch: hasToolEnding(activeTools, "search_structural"),
		hasStructuralPatterns: hasToolEnding(activeTools, "get_structural_patterns"),
		hasRenameRefactoring: hasToolEnding(activeTools, "rename_refactoring"),
	};
}

export function hasSymbolGuidanceTarget(capabilities: ToolCapabilities): boolean {
	return capabilities.proxyOnly
		|| capabilities.hasSearchSymbol
		|| capabilities.hasSymbolInfo
		|| capabilities.hasStructuralSearch
		|| capabilities.hasRenameRefactoring;
}

export function buildCapabilitiesLine(capabilities: ToolCapabilities): string {
	if (capabilities.proxyOnly) {
		return "capabilities: proxy mode (discover concrete tools via mcp server metadata)";
	}

	return [
		`search_symbol=${capabilities.hasSearchSymbol ? "yes" : "no"}`,
		`symbol_info=${capabilities.hasSymbolInfo ? "yes" : "no"}`,
		`search_structural=${capabilities.hasStructuralSearch ? "yes" : "no"}`,
		`structural_patterns=${capabilities.hasStructuralPatterns ? "yes" : "no"}`,
		`rename_refactoring=${capabilities.hasRenameRefactoring ? "yes" : "no"}`,
	].join(", ");
}
