/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { formatToolCall } from "./formatters.ts";
import type { AgentProgress, Details, DisplayItem, ErrorInfo, SingleResult, ToolCallSummary } from "./types.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return baseCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

/**
 * Find the latest session file in a directory
 */
export function findLatestSessionFile(sessionDir: string): string | null {
	if (!fs.existsSync(sessionDir)) return null;
	const files = fs.readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const filePath = path.join(sessionDir, f);
			return {
				path: filePath,
				mtime: fs.statSync(filePath).mtimeMs,
			};
		})
		.sort((a, b) => b.mtime - a.mtime);
	return files.length > 0 ? files[0].path : null;
}

/**
 * Write a prompt to a temporary file
 */
export function writePrompt(agent: string, prompt: string): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const p = path.join(dir, `${agent.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(p, prompt, { mode: 0o600 });
	return { dir, path: p };
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function getSingleResultOutput(result: Pick<SingleResult, "finalOutput" | "messages">): string {
	return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}

/**
 * Extract display items (text and tool calls) from messages
 */
export function getDisplayItems(messages: Message[] | undefined): DisplayItem[] {
	if (!messages || messages.length === 0) return [];
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function compactCompletedProgress(progress: AgentProgress): AgentProgress {
	if (progress.status === "running") return progress;
	return {
		index: progress.index,
		agent: progress.agent,
		status: progress.status,
		task: progress.task,
		skills: progress.skills,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
		error: progress.error,
		failedTool: progress.failedTool,
		recentTools: [],
		recentOutput: [],
	};
}

export function extractToolCallSummaries(messages: Message[] | undefined): ToolCallSummary[] {
	if (!messages?.length) return [];
	const summaries: ToolCallSummary[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments
				: {};
			summaries.push({
				text: formatToolCall(part.name, args),
				expandedText: formatToolCall(part.name, args, true),
			});
		}
	}
	return summaries;
}

export function compactForegroundResult(result: SingleResult): SingleResult {
	if (result.progress?.status === "running") return result;
	const toolCalls = result.toolCalls?.length ? result.toolCalls : extractToolCallSummaries(result.messages);
	return {
		...result,
		messages: undefined,
		progress: undefined,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

export function compactForegroundDetails(details: Details): Details {
	return {
		...details,
		results: details.results.map(compactForegroundResult),
		progress: details.progress
			? details.progress.map(compactCompletedProgress)
			: undefined,
	};
}

/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	let lastAssistantTextIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const hasText = Array.isArray(msg.content) && msg.content.some(
				(c) => c.type === "text" && "text" in c && typeof c.text === "string" && c.text.trim().length > 0,
			);
			if (hasText) {
				lastAssistantTextIndex = i;
				break;
			}
		}
	}

	if (lastAssistantTextIndex === -1) {
		const lastAssistant = messages.find((m) => m.role === "assistant");
		if (lastAssistant && lastAssistant.content) {
			const lastToolCall = (lastAssistant.content as Array<{ type?: string; name?: string }>)
				.find((c) => c.type === "toolCall");
			if (lastToolCall?.name) {
				return {
					hasError: true,
					errorType: "incomplete_tool_call",
					details: `Last action was a tool call to ${lastToolCall.name} that did not complete`,
				};
			}
		}
	}

	const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;

	for (let i = messages.length - 1; i >= scanStart; i--) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
		const isError = "isError" in msg && msg.isError === true;

		if (isError) {
			const text = msg.content.find((c): c is TextContent => c.type === "text");
			const details = text?.text;
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: toolName || "tool",
				details: details?.slice(0, 200),
			};
		}

	}

	return { hasError: false };
}

// ============================================================================
// Tool Call Formatting
// ============================================================================

export function extractToolArgsPreview(args: Record<string, unknown>): string {
	if (!args || Object.keys(args).length === 0) return "";
	const previewParts: string[] = [];
	if (typeof args.path === "string") {
		previewParts.push(`path="${args.path}"`);
	} else if (typeof args.file === "string") {
		previewParts.push(`file="${args.file}"`);
	} else if (typeof args.command === "string") {
		previewParts.push(`cmd="${args.command.slice(0, 120)}${args.command.length > 120 ? "..." : ""}"`);
	} else if (typeof args.content === "string") {
		previewParts.push(`content="${args.content.slice(0, 60)}..."`);
	} else if (typeof args.url === "string") {
		previewParts.push(`url="${args.url}"`);
	} else if (typeof args.query === "string") {
		previewParts.push(`query="${args.query}"`);
	} else if (typeof args.tool === "string") {
		previewParts.push(`tool="${args.tool}"`);
	} else if (typeof args.pattern === "string") {
		previewParts.push(`pattern="${args.pattern}"`);
	}
	return previewParts.join(", ");
}

// ============================================================================
// Text Content Extraction
// ============================================================================

export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export { mapConcurrent } from "./parallel-utils.ts";
