import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	formatDuration,
	SUBAGENT_REPORT_MESSAGE_TYPE,
	type SubagentReportItem,
	type SubagentReportMessageDetails,
} from "../reporting.js";

const PREVIEW_REPORT_CHUNKS = 4;

function runtimeLabel(result: SubagentReportItem): string {
	return `${result.runtime ?? "tmux"}/${result.executionMode ?? "interactive"}`;
}

class SubagentReportMessageComponent implements Component {
	constructor(
		private readonly details: SubagentReportMessageDetails,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const w = Math.max(20, width);
		const reportLineWidth = Math.max(8, w - 8);

		lines.push(
			truncateToWidth(
				this.theme.fg("accent", "◆ ") +
					this.theme.fg("customMessageLabel", this.theme.bold("Subagent reports")),
				w,
			),
		);

		if (!this.expanded) {
			lines.push(
				truncateToWidth(this.theme.fg("muted", "  click message to expand full reports"), w),
			);
		}

		for (let i = 0; i < this.details.results.length; i++) {
			const result = this.details.results[i]!;
			const icon = result.status === "ok" ? "✅" : "❌";
			const header = `${icon} ${result.label} (${formatDuration(result.durationMs)} | ${runtimeLabel(result)})`;
			lines.push(truncateToWidth(header, w));

			if (result.tmuxPaneId) {
				const pane = `   Pane: ${result.tmuxPaneId}${result.tmuxSessionName ? ` (${result.tmuxSessionName})` : ""}`;
				lines.push(truncateToWidth(this.theme.fg("dim", pane), w));
			}

			if (result.report?.trim()) {
				const reportLines = result.report.replace(/\r\n/g, "\n").trim().split("\n");
				const visibleChunks: string[] = [];
				let truncated = false;

				if (this.expanded) {
					for (const reportLine of reportLines) {
						const wrapped = wrapTextWithAnsi(reportLine || " ", reportLineWidth);
						if (wrapped.length === 0) {
							visibleChunks.push(" ");
							continue;
						}
						visibleChunks.push(...wrapped);
					}
				} else {
					reportLoop: for (const reportLine of reportLines) {
						const wrapped = wrapTextWithAnsi(reportLine || " ", reportLineWidth);
						const chunks = wrapped.length > 0 ? wrapped : [" "];
						for (const chunk of chunks) {
							if (visibleChunks.length >= PREVIEW_REPORT_CHUNKS) {
								truncated = true;
								break reportLoop;
							}
							visibleChunks.push(chunk);
						}
					}
				}

				lines.push(truncateToWidth(this.theme.fg("dim", "   Report:"), w));
				for (const chunk of visibleChunks) {
					lines.push(truncateToWidth(this.theme.fg("dim", `      ${chunk}`), w));
				}

				if (!this.expanded && truncated) {
					lines.push(
						truncateToWidth(
							this.theme.fg("muted", "      ... more (expand to view)"),
							w,
						),
					);
				}
			}

			if (result.error) {
				for (const chunk of wrapTextWithAnsi(`   Error: ${result.error}`, Math.max(8, w - 3))) {
					lines.push(truncateToWidth(this.theme.fg("error", chunk), w));
				}
			}

			if (i < this.details.results.length - 1) {
				lines.push("");
			}
		}

		return lines;
	}
}

export function registerSubagentReportMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(SUBAGENT_REPORT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as SubagentReportMessageDetails | undefined;
		if (!details || details.kind !== "subagents-lite-report" || !Array.isArray(details.results)) {
			return undefined;
		}
		return new SubagentReportMessageComponent(details, theme, Boolean(options.expanded));
	});
}
