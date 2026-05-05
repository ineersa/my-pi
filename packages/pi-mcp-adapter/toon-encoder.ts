// toon-encoder.ts - Optionally encode MCP JSON responses as TOON for token efficiency
import { encode } from "@toon-format/toon";
import type { ContentBlock } from "./types.js";
import type { McpConfig } from "./types.js";

/**
 * Check whether TOON encoding is enabled for a given server.
 */
export function isToonEnabled(serverName: string, config: McpConfig): boolean {
	const setting = config.settings?.toonEncode;
	if (setting === undefined || setting === false) return false;
	if (setting === true) return true;
	return Array.isArray(setting) && setting.includes(serverName);
}

/**
 * Attempt to TOON-encode text content blocks that contain valid JSON.
 * Non-JSON text and non-text blocks pass through unchanged.
 * Only uses TOON when it produces shorter output than the original.
 */
export function maybeEncodeToon(
	content: ContentBlock[],
	serverName: string,
	config: McpConfig,
): ContentBlock[] {
	if (!isToonEnabled(serverName, config)) return content;

	return content.map(block => {
		if (block.type !== "text") return block;

		// Only try encoding on text that looks like JSON
		const trimmed = block.text.trim();
		if (trimmed.length < 2) return block;
		const first = trimmed[0];
		if (first !== "{" && first !== "[") return block;

		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) return block;

			const toonText = encode(parsed);
			// Only use TOON if it's actually shorter
			if (toonText.length >= trimmed.length) return block;

			return { type: "text" as const, text: toonText };
		} catch {
			return block;
		}
	});
}
