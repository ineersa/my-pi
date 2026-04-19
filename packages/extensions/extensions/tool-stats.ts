/**
 * Tool call statistics tracker for the session.
 *
 * Subscribes to pi tool_call / tool_result events and exposes
 * counts used by the custom-footer extension.
 */

export interface ToolStats {
	/** Total read tool calls (any file). */
	reads: number;
	/** Reads without BOTH offset AND limit (unbounded / full file reads). */
	readsUnbounded: number;
	/** Reads of files matching *.toon (regardless of boundedness). */
	readsToon: number;
	/** Calls to jetbrains_index_ide_* custom tools. */
	ideToolCalls: number;
}

/** Reset counters (called on session_start). */
function fresh(): ToolStats {
	return { reads: 0, readsUnbounded: 0, readsToon: 0, ideToolCalls: 0 };
}

let stats = fresh();

/** Return a snapshot of the current stats. */
export function getToolStats(): ToolStats {
	return stats;
}

/** Reset stats — call on session_start. */
export function resetToolStats(): void {
	stats = fresh();
}

const TOON_RE = /\.toon$/i;
const IDE_TOOL_PREFIX = "jetbrains_index_ide_";

/** Feed a tool_call event into the tracker. */
export function handleToolCall(event: {
	toolName: string;
	input: Record<string, unknown>;
}): void {
	if (event.toolName === "read") {
		stats.reads++;
		const { offset, limit, path } = event.input as {
			path?: string;
			offset?: number;
			limit?: number;
		};
		if (offset === undefined && limit === undefined) {
			stats.readsUnbounded++;
		}
		if (typeof path === "string" && TOON_RE.test(path)) {
			stats.readsToon++;
		}
	} else if (event.toolName.startsWith(IDE_TOOL_PREFIX)) {
		stats.ideToolCalls++;
	}
}
