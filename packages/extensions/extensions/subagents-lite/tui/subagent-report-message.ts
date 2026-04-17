import {
	getMarkdownTheme,
	type ExtensionAPI,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
	formatDuration,
	SUBAGENT_REPORT_MESSAGE_TYPE,
	type SubagentReportItem,
	type SubagentReportMessageDetails,
} from "../reporting.js";

const PREVIEW_REPORT_LINES = 10;
const PREVIEW_REPORT_MAX_CHARS = 2400;

interface ReportPreview {
	text: string;
	truncated: boolean;
	hiddenLines: number;
	hiddenContentByChars: boolean;
}

function runtimeLabel(result: SubagentReportItem): string {
	return `${result.runtime ?? "tmux"}/${result.executionMode ?? "interactive"}`;
}

function normalizeReport(report: string): string {
	return report.replace(/\r\n/g, "\n").trim();
}

function previewReport(report: string): ReportPreview {
	const normalized = normalizeReport(report);
	if (!normalized) {
		return { text: "", truncated: false, hiddenLines: 0, hiddenContentByChars: false };
	}

	const lines = normalized.split("\n");
	const hiddenLines = Math.max(0, lines.length - PREVIEW_REPORT_LINES);
	const visibleLines = lines.slice(0, PREVIEW_REPORT_LINES);

	let text = visibleLines.join("\n").trimEnd();
	let hiddenContentByChars = false;
	if (text.length > PREVIEW_REPORT_MAX_CHARS) {
		hiddenContentByChars = true;
		text = `${text.slice(0, PREVIEW_REPORT_MAX_CHARS - 3)}...`;
	}

	return {
		text,
		truncated: hiddenLines > 0 || hiddenContentByChars,
		hiddenLines,
		hiddenContentByChars,
	};
}

function reportForDisplay(report: string, expanded: boolean): ReportPreview {
	if (expanded) {
		return {
			text: normalizeReport(report),
			truncated: false,
			hiddenLines: 0,
			hiddenContentByChars: false,
		};
	}
	return previewReport(report);
}

function truncationHint(preview: ReportPreview): string {
	if (preview.hiddenLines > 0) {
		const plural = preview.hiddenLines === 1 ? "" : "s";
		return `> ... ${preview.hiddenLines} more line${plural} (expand to view full report)`;
	}
	if (preview.hiddenContentByChars) {
		return "> ... more content (expand to view full report)";
	}
	return "";
}

function buildReportMarkdown(
	details: SubagentReportMessageDetails,
	expanded: boolean,
): string {
	const sections: string[] = [];

	for (const result of details.results) {
		const lines: string[] = [];
		const icon = result.status === "ok" ? "✅" : "❌";

		lines.push(`### ${icon} ${result.label}`);
		lines.push(`- Duration: \`${formatDuration(result.durationMs)}\``);
		lines.push(`- Runtime: \`${runtimeLabel(result)}\``);

		if (result.tmuxPaneId) {
			const pane = `${result.tmuxPaneId}${result.tmuxSessionName ? ` (${result.tmuxSessionName})` : ""}`;
			lines.push(`- Pane: \`${pane}\``);
		}

		if (result.report?.trim()) {
			const reportPreview = reportForDisplay(result.report, expanded);
			if (reportPreview.text) {
				lines.push("");
				lines.push(reportPreview.text);
			}
			if (reportPreview.truncated && !expanded) {
				lines.push("");
				lines.push(truncationHint(reportPreview));
			}
		}

		if (result.error) {
			lines.push(`- Error: ${result.error}`);
		}

		sections.push(lines.join("\n").trim());
	}

	if (sections.length === 0) {
		return "_No subagent results available._";
	}

	return sections.join("\n\n---\n\n");
}

function buildComponent(
	details: SubagentReportMessageDetails,
	theme: Theme,
	expanded: boolean,
): Component {
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

	box.addChild(
		new Text(
			theme.fg("accent", "◆ ") +
				theme.fg("customMessageLabel", theme.bold("Subagent reports")),
			0,
			0,
		),
	);
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(
			buildReportMarkdown(details, expanded),
			0,
			0,
			getMarkdownTheme(),
			{
				color: (text) => theme.fg("customMessageText", text),
			},
		),
	);

	return box;
}

export function registerSubagentReportMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(SUBAGENT_REPORT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as SubagentReportMessageDetails | undefined;
		if (
			!details ||
			details.kind !== "subagents-lite-report" ||
			!Array.isArray(details.results)
		) {
			return undefined;
		}
		return buildComponent(details, theme, Boolean(options.expanded));
	});
}
