/**
 * Response formatting helpers for JetBrains IDE MCP tool results.
 *
 * Extracted from the previous monolithic JetBrainsService into standalone
 * pure functions so tool wrappers and shared helpers don't need a full
 * service instance just for formatting.
 */
import { encode as toonEncode } from "@toon-format/toon";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!(value && typeof value === "object")) {
		return null;
	}
	return value as Record<string, unknown>;
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Extract text blocks from an MCP ToolResult content array.
 */
function extractMcpTextBlocks(result: unknown): string[] {
	const rec = asRecord(result);
	if (!rec) return [];
	const content = rec.content;
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		const b = asRecord(block);
		if (b?.type === "text" && typeof b.text === "string") {
			texts.push(b.text);
		}
	}
	return texts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode data as TOON text for model consumption.
 * Always TOON. Never JSON fallback. Strings pass through as-is.
 */
export function toToon(data: unknown): string {
	if (typeof data === "string") return data;
	if (typeof data !== "object" || data === null) {
		return String(data);
	}
	try {
		return toonEncode(data);
	} catch {
		return JSON.stringify(data);
	}
}

/**
 * Decode the actual data payload from a JetBrains MCP tool result.
 *
 * The MCP backend wraps data in content blocks:
 *   { content: [{ type: "text", text: "<JSON string>" }], isError: false }
 *
 * This helper extracts content[0].text, JSON-decodes if the text is JSON,
 * and returns the decoded data. Multiple blocks are decoded individually.
 * Falls back to the raw result object if no text blocks are found.
 */
export function decodeMcpPayload(result: unknown): unknown {
	const texts = extractMcpTextBlocks(result);
	if (texts.length === 0) {
		// No text blocks found — return the raw result as fallback
		return result;
	}

	if (texts.length === 1) {
		const parsed = parseJson(texts[0]);
		return parsed ?? texts[0];
	}

	// Multiple text blocks — decode each individually
	return texts.map((t) => {
		const parsed = parseJson(t);
		return parsed ?? t;
	});
}

/**
 * Check whether an MCP ToolResult indicates an error.
 */
export function isMcpError(result: unknown): boolean {
	const rec = asRecord(result);
	return rec?.isError === true;
}

/**
 * Extract the first meaningful error text from an MCP error result.
 */
export function getMcpErrorText(result: unknown): string | undefined {
	const texts = extractMcpTextBlocks(result);
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Build a standard error object for MCP tool failures.
 */
export function makeError(error: string, hint: string, isRetryable: boolean): Record<string, unknown> {
	return { error, hint, isRetryable };
}
