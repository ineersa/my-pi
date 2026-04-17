/**
 * Subagents status overlay — shows active + recent runs.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { RunSummary } from "../history/status-store.js";
import { listRuns, markRunDone } from "../history/status-store.js";
import { killPane, sendCtrlCToPane, switchClientToPane } from "../lib/tmux.js";
import {
	formatDuration,
	formatScrollInfo,
	renderFooter,
	renderHeader,
	row,
	shortenPath,
} from "./render-helpers.js";

const AUTO_REFRESH_MS = 2000;

interface StatusRow {
	kind: "section" | "run";
	label: string;
	run?: RunSummary;
}

function statusColor(theme: Theme, state: RunSummary["state"]): string {
	switch (state) {
		case "running":
			return theme.fg("warning", state);
		case "complete":
			return theme.fg("success", state);
		case "failed":
			return theme.fg("error", state);
	}
}

function stepStatusColor(theme: Theme, status: string): string {
	if (status === "running") return theme.fg("warning", status);
	if (status === "pending") return theme.fg("dim", status);
	if (status === "ok" || status === "completed") return theme.fg("success", status);
	if (status === "error" || status === "failed") return theme.fg("error", status);
	return status;
}

function buildRows(runs: RunSummary[]): StatusRow[] {
	const rows: StatusRow[] = [];
	const active = runs.filter((r) => r.state === "running");
	const done = runs.filter((r) => r.state !== "running");

	if (active.length > 0) {
		rows.push({ kind: "section", label: "Active" });
		for (const run of active) rows.push({ kind: "run", label: run.runId, run });
	}
	if (done.length > 0) {
		rows.push({ kind: "section", label: "Recent" });
		for (const run of done) rows.push({ kind: "run", label: run.runId, run });
	}
	return rows;
}

function summarizeAgentTypes(run: RunSummary): string {
	const counts = new Map<string, number>();
	for (const step of run.steps) {
		counts.set(step.agent, (counts.get(step.agent) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");
}

export class SubagentsStatusComponent implements Component {
	private readonly width = 160;
	private readonly viewportHeight = 24;
	private cursor = 0;
	private scrollOffset = 0;
	private rows: StatusRow[] = [];
	private refreshTimer: NodeJS.Timeout;

	private hintMessage = "";
	private hintUntil = 0;
	private expandedReportRuns = new Set<string>();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
	) {
		this.reload();
		this.refreshTimer = setInterval(() => {
			this.reload();
			this.tui.requestRender();
		}, AUTO_REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	private setHint(message: string): void {
		this.hintMessage = message;
		this.hintUntil = Date.now() + 2500;
	}

	private reload(): void {
		const previousSelectedId = this.selectedRun?.runId;
		const runs = listRuns(20);
		this.rows = buildRows(runs);
		this.restoreSelection(previousSelectedId);
		this.ensureScrollVisible();
	}

	private getInteractiveTmuxStep(run: RunSummary): RunSummary["steps"][number] | undefined {
		return (
			run.steps.find((s) => s.status === "running" && !!s.tmuxPaneId) ??
			run.steps.find((s) => !!s.tmuxPaneId)
		);
	}

	private jumpToRunPane(run: RunSummary): boolean {
		const step = this.getInteractiveTmuxStep(run);
		if (!step?.tmuxPaneId) return false;
		const ok = switchClientToPane(
			step.tmuxPaneId,
			step.tmuxWindowId,
			step.tmuxSessionName,
		);
		if (!ok) {
			this.setHint(`Could not switch to pane ${step.tmuxPaneId}`);
			this.tui.requestRender();
			return false;
		}
		this.done();
		return true;
	}

	private interruptRun(run: RunSummary, forceKillTmuxPane: boolean): boolean {
		let interrupted = false;
		for (const step of run.steps) {
			if (step.tmuxPaneId) {
				const ok = forceKillTmuxPane
					? killPane(step.tmuxPaneId)
					: sendCtrlCToPane(step.tmuxPaneId);
				if (ok) interrupted = true;
				continue;
			}
			if (step.status !== "running") continue;
			if (step.pid) {
				try {
					process.kill(step.pid, "SIGINT");
					interrupted = true;
				} catch {
					// ignore
				}
			}
		}
		return interrupted;
	}

	private markRunAsDone(run: RunSummary): void {
		markRunDone(run.runId);
		this.setHint(`Marked run ${run.runId.slice(0, 8)} as done`);
		this.reload();
		this.tui.requestRender();
	}

	private get selectedRun(): RunSummary | undefined {
		const runRows = this.rows.filter((r) => r.kind === "run");
		const idx = Math.max(0, Math.min(this.cursor, runRows.length - 1));
		return runRows[idx]?.run;
	}

	private restoreSelection(previousId?: string): void {
		const runRows = this.rows.filter((r) => r.kind === "run");
		if (runRows.length === 0) {
			this.cursor = 0;
			return;
		}
		if (previousId) {
			const nextIdx = runRows.findIndex((r) => r.run?.runId === previousId);
			if (nextIdx !== -1) {
				this.cursor = nextIdx;
				return;
			}
		}
		this.cursor = Math.min(this.cursor, runRows.length - 1);
	}

	private ensureScrollVisible(): void {
		if (this.rows.length <= this.viewportHeight) {
			this.scrollOffset = 0;
			return;
		}
		const runRows = this.rows.filter((r) => r.kind === "run");
		const selected = runRows[this.cursor];
		if (!selected) return;
		const rowIndex = this.rows.indexOf(selected);
		if (rowIndex < this.scrollOffset) this.scrollOffset = rowIndex;
		if (rowIndex >= this.scrollOffset + this.viewportHeight)
			this.scrollOffset = rowIndex - this.viewportHeight + 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}

		if (matchesKey(data, "enter") || matchesKey(data, "j")) {
			const run = this.selectedRun;
			if (!run) return;
			if (this.jumpToRunPane(run)) return;
			this.setHint("No tmux pane found for this run");
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "k")) {
			const run = this.selectedRun;
			if (run) {
				this.interruptRun(run, false);
				this.reload();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "shift+k")) {
			const run = this.selectedRun;
			if (run) {
				this.interruptRun(run, true);
				this.reload();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "m")) {
			const run = this.selectedRun;
			if (run && run.state === "running") {
				this.markRunAsDone(run);
			}
			return;
		}

		if (matchesKey(data, "r")) {
			const run = this.selectedRun;
			if (!run) return;
			if (this.expandedReportRuns.has(run.runId)) {
				this.expandedReportRuns.delete(run.runId);
			} else {
				this.expandedReportRuns.add(run.runId);
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			const runRows = this.rows.filter((r) => r.kind === "run");
			this.cursor = Math.min(Math.max(0, runRows.length - 1), this.cursor + 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, this.width);
		const innerW = w - 2;

		const lines: string[] = [renderHeader("Subagents Status", w, this.theme)];

		if (this.rows.length === 0) {
			lines.push(row(this.theme.fg("dim", "No runs found."), w, this.theme));
			lines.push(renderFooter("esc close", w, this.theme));
			return lines;
		}

		const visibleRows = this.rows.slice(
			this.scrollOffset,
			this.scrollOffset + this.viewportHeight,
		);
		const selected = this.selectedRun;

		for (const statusRow of visibleRows) {
			if (statusRow.kind === "section") {
				lines.push(row(this.theme.fg("accent", statusRow.label), w, this.theme));
				continue;
			}
			const run = statusRow.run!;
			const isSelected = selected?.runId === run.runId;
			const prefix = isSelected ? this.theme.fg("accent", ">") : " ";
			const stepLabel = `${run.steps.length} step${run.steps.length !== 1 ? "s" : ""}`;
			const runtime = run.steps.find((s) => !!s.runtime)?.runtime ?? "tmux";
			const executionMode = run.executionMode ?? "interactive";
			const agentTypes = summarizeAgentTypes(run);
			const line = `${prefix} ${run.runId.slice(0, 8)} ${statusColor(this.theme, run.state)} | ${runtime}/${executionMode} | ${stepLabel} | ${agentTypes}`;
			lines.push(row(truncateToWidth(line, innerW), w, this.theme));
		}

		const above = this.scrollOffset;
		const below = Math.max(0, this.rows.length - (this.scrollOffset + visibleRows.length));
		const scrollInfo = formatScrollInfo(above, below);
		if (scrollInfo) lines.push(row(this.theme.fg("dim", scrollInfo), w, this.theme));

		if (selected) {
			const reportExpanded = this.expandedReportRuns.has(selected.runId);
			lines.push(row(this.theme.fg("accent", `Selected: ${selected.runId}`), w, this.theme));
			if (selected.cwd) {
				lines.push(
					row(`cwd: ${truncateToWidth(shortenPath(selected.cwd), innerW - 5)}`, w, this.theme),
				);
			}
			const agentTypes = summarizeAgentTypes(selected);
			if (agentTypes) {
				lines.push(row(truncateToWidth(`agents: ${agentTypes}`, innerW), w, this.theme));
			}
			const preview = selected.steps.find((s) => s.taskPreview)?.taskPreview;
			if (preview) {
				lines.push(
					row(
						truncateToWidth(`task: ${preview}`, innerW),
						w,
						this.theme,
					),
				);
			}
			for (const step of selected.steps) {
				const duration = step.durationMs !== undefined ? ` | ${formatDuration(step.durationMs)}` : "";
				const runtime = step.runtime ? ` | ${step.runtime}` : "";
				const stepLine = `  ${step.agent} (${step.label}) | ${stepStatusColor(this.theme, step.status)}${duration}${runtime}`;
				lines.push(row(truncateToWidth(stepLine, innerW), w, this.theme));
				if (step.tmuxPaneId) {
					lines.push(
						row(
							truncateToWidth(
								`     Pane: ${step.tmuxPaneId}${step.tmuxSessionName ? ` (${step.tmuxSessionName})` : ""}`,
								innerW,
							),
							w,
							this.theme,
						),
					);
				}
				if (step.report) {
					const reportLineWidth = Math.max(10, innerW - 13);
					const reportLines = step.report.replace(/\r\n/g, "\n").trimEnd().split("\n");
					const reportChunks: string[] = [];
					let truncated = false;

					if (reportExpanded) {
						for (const reportLine of reportLines) {
							const wrapped = wrapTextWithAnsi(reportLine || " ", reportLineWidth);
							if (wrapped.length === 0) {
								reportChunks.push(" ");
								continue;
							}
							reportChunks.push(...wrapped);
						}
					} else {
						reportLoop: for (const reportLine of reportLines) {
							const wrapped = wrapTextWithAnsi(reportLine || " ", reportLineWidth);
							const chunks = wrapped.length > 0 ? wrapped : [" "];
							for (const chunk of chunks) {
								if (reportChunks.length >= 1) {
									truncated = true;
									break reportLoop;
								}
								reportChunks.push(chunk);
							}
						}
					}

					for (const chunk of reportChunks) {
						lines.push(
							row(
								truncateToWidth(`     Report: ${chunk}`, innerW),
								w,
								this.theme,
							),
						);
					}
					if (!reportExpanded && truncated) {
						lines.push(
							row(
								truncateToWidth("            ... more (press r)", innerW),
								w,
								this.theme,
							),
						);
					}
				}
				const configuredSkills = step.configuredSkills ?? [];
				const resolvedSkills = step.resolvedSkills ?? [];
				const missingSkills = step.missingSkills ?? [];
				if (
					configuredSkills.length > 0 ||
					resolvedSkills.length > 0 ||
					missingSkills.length > 0
				) {
					const skillsSummary = [
						`cfg:[${configuredSkills.join(", ") || "-"}]`,
						`ok:[${resolvedSkills.join(", ") || "-"}]`,
						`missing:[${missingSkills.join(", ") || "-"}]`,
					].join(" ");
					lines.push(row(truncateToWidth(`     Skills ${skillsSummary}`, innerW), w, this.theme));
				}
				if (step.error) {
					lines.push(row(truncateToWidth(`     ${step.error}`, innerW), w, this.theme));
				}
			}
		}

		if (this.hintMessage && Date.now() < this.hintUntil) {
			lines.push(row(this.theme.fg("warning", truncateToWidth(this.hintMessage, innerW)), w, this.theme));
		}

		const active = this.rows.filter((r) => r.kind === "run" && r.run?.state === "running").length;
		const recent = this.rows.filter((r) => r.kind === "run" && r.run?.state !== "running").length;
		const footer = `↑↓ select  enter/j jump pane  r toggle report  k stop  shift+k kill pane  m mark done  esc/q close  ${active} active / ${recent} recent`;
		lines.push(renderFooter(footer, w, this.theme));
		return lines;
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}
