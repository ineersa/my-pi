import type { SubagentExecutionMode, SubagentRunResult, SubagentRuntime } from "./types.js";

export const SUBAGENT_REPORT_MESSAGE_TYPE = "subagents-lite-report";

const REPORT_PREVIEW_MAX_LEN = 220;

export interface SubagentReportItem {
	label: string;
	status: "ok" | "error";
	durationMs: number;
	runtime?: SubagentRuntime;
	executionMode?: SubagentExecutionMode;
	tmuxPaneId?: string;
	tmuxSessionName?: string;
	report?: string;
	error?: string;
}

export interface SubagentReportMessageDetails {
	kind: "subagents-lite-report";
	results: SubagentReportItem[];
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function previewReport(report: string): { text: string; truncated: boolean } {
	const compact = report.replace(/\s+/g, " ").trim();
	if (!compact) {
		return { text: "", truncated: false };
	}
	if (compact.length <= REPORT_PREVIEW_MAX_LEN) {
		return { text: compact, truncated: false };
	}
	return {
		text: `${compact.slice(0, REPORT_PREVIEW_MAX_LEN - 3)}...`,
		truncated: true,
	};
}

export function formatResultSummary(results: SubagentRunResult[]): string {
	const lines: string[] = [];
	let hasTruncatedReport = false;

	for (const r of results) {
		const icon = r.status === "ok" ? "✅" : "❌";
		const duration = formatDuration(r.durationMs);
		const runtime = r.runtime ?? "tmux";
		const executionMode = r.executionMode ?? "interactive";
		lines.push(`${icon} **${r.label}** (${duration} | ${runtime}/${executionMode})`);
		if (r.tmuxPaneId) {
			lines.push(
				`   Pane: ${r.tmuxPaneId}${r.tmuxSessionName ? ` (${r.tmuxSessionName})` : ""}`,
			);
		}
		if (r.report) {
			const preview = previewReport(r.report);
			if (preview.text) {
				lines.push(`   Report: ${preview.text}`);
			}
			hasTruncatedReport = hasTruncatedReport || preview.truncated;
		}
		if (r.error) {
			lines.push(`   Error: ${r.error}`);
		}
		lines.push("");
	}

	if (hasTruncatedReport) {
		lines.push("Tip: expand this message to read full subagent reports.");
	}

	return lines.join("\n").trimEnd();
}

export function buildSubagentReportMessage(results: SubagentRunResult[]): {
	customType: string;
	content: string;
	display: true;
	details: SubagentReportMessageDetails;
} {
	const details: SubagentReportMessageDetails = {
		kind: "subagents-lite-report",
		results: results.map((r) => ({
			label: r.label,
			status: r.status,
			durationMs: r.durationMs,
			runtime: r.runtime,
			executionMode: r.executionMode,
			tmuxPaneId: r.tmuxPaneId,
			tmuxSessionName: r.tmuxSessionName,
			report: r.report,
			error: r.error,
		})),
	};

	return {
		customType: SUBAGENT_REPORT_MESSAGE_TYPE,
		content: formatResultSummary(results),
		display: true,
		details,
	};
}
