/**
 * my-pi Compact Header — sticky widget with MCP server status
 *
 * Uses setWidget with "aboveEditor" placement to stay fixed
 * at the top of the viewport, re-registered after each turn.
 *
 * Also bootstraps the plain-icons setting: reads `plainIcons` from
 * settings.json and/or the `--plain-icons` CLI flag, and bridges it
 * to the `MY_PI_PLAIN_ICONS` env var.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getSafeModeState, subscribeSafeMode } from "./runtime-mode";
import { getMcpServerStatus } from "./mcp-shared-state.js";
import { discoverAgents } from "./subagents-lite/agent-registry.js";
import { listRuns } from "./subagents-lite/history/status-store.js";

/** Read `plainIcons` from settings.json (global or project-local). */
function loadPlainIconsSetting(): boolean {
	for (const dir of [join(process.cwd(), ".pi"), getAgentDir()]) {
		try {
			const raw = readFileSync(join(dir, "settings.json"), "utf8");
			const settings = JSON.parse(raw);
			if (settings.plainIcons === true) {
				return true;
			}
		} catch {
			/* file missing or unparseable — skip */
		}
	}
	return false;
}

interface SubagentsHeaderSnapshot {
	availableAgents: number;
	runningRuns: number;
	runningAgents: number;
	availableAgentNames: string[];
	runningAgentNames: string[];
}

const SUBAGENTS_SNAPSHOT_TTL_MS = 2000;
let subagentsSnapshotCache:
	| {
			cwd: string;
			ts: number;
			snapshot: SubagentsHeaderSnapshot;
	  }
	| undefined;

function formatAgentNameSummary(names: string[]): string {
	if (names.length === 0) return "none";
	const counts = new Map<string, number>();
	for (const name of names) {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");
}

function getSubagentsHeaderSnapshot(cwd: string): SubagentsHeaderSnapshot {
	const now = Date.now();
	if (
		subagentsSnapshotCache &&
		subagentsSnapshotCache.cwd === cwd &&
		now - subagentsSnapshotCache.ts < SUBAGENTS_SNAPSHOT_TTL_MS
	) {
		return subagentsSnapshotCache.snapshot;
	}

	let availableAgentNames: string[] = [];
	let availableAgents = 0;
	try {
		availableAgentNames = discoverAgents(cwd)
			.map((agent) => agent.name)
			.sort((a, b) => a.localeCompare(b));
		availableAgents = availableAgentNames.length;
	} catch {
		availableAgentNames = [];
		availableAgents = 0;
	}

	let runningRuns = 0;
	let runningAgents = 0;
	let runningAgentNames: string[] = [];
	try {
		const runs = listRuns(30);
		for (const run of runs) {
			if (run.state !== "running") continue;
			runningRuns += 1;
			for (const step of run.steps) {
				if (step.status !== "running") continue;
				runningAgents += 1;
				runningAgentNames.push(step.agent);
			}
		}
	} catch {
		runningRuns = 0;
		runningAgents = 0;
		runningAgentNames = [];
	}

	const snapshot = {
		availableAgents,
		runningRuns,
		runningAgents,
		availableAgentNames,
		runningAgentNames,
	};
	subagentsSnapshotCache = { cwd, ts: now, snapshot };
	return snapshot;
}

export default function (pi: ExtensionAPI) {
	// Register --plain-icons CLI flag
	pi.registerFlag("plain-icons", {
		description:
			"Use ASCII-safe icons instead of emoji (same as MY_PI_PLAIN_ICONS=1 or plainIcons in settings.json)",
		type: "boolean",
		default: false,
	});

	// Bridge settings.json and --plain-icons flag to env vars.
	// MY_PI_PLAIN_ICONS is preferred, OH_PI_PLAIN_ICONS is kept for compatibility.
	const envPlainIcons = process.env.MY_PI_PLAIN_ICONS ?? process.env.OH_PI_PLAIN_ICONS;
	if (!envPlainIcons) {
		const fromFlag = pi.getFlag("plain-icons");
		if (fromFlag === true || loadPlainIconsSetting()) {
			process.env.MY_PI_PLAIN_ICONS = "1";
			process.env.OH_PI_PLAIN_ICONS = "1";
		}
	} else {
		process.env.MY_PI_PLAIN_ICONS ??= envPlainIcons;
		process.env.OH_PI_PLAIN_ICONS ??= envPlainIcons;
	}

	// Widget factory — reads MCP status live on every render
	function createWidget(ctx: ExtensionContext): (tui: any, theme: any) => any {
		return (tui, theme) => {
			const unsubSafeMode = subscribeSafeMode(() => tui.requestRender());
			return {
				dispose() {
					unsubSafeMode();
				},
				render(width: number): string[] {
					if (getSafeModeState().enabled) {
						return [];
					}
					const d = (s: string) => theme.fg("dim", s);
					const a = (s: string) => theme.fg("accent", s);

					const cmds = pi.getCommands();
					const prompts = cmds
						.filter((c) => c.source === "prompt")
						.map((c) => `/${c.name}`)
						.join("  ");
					const skills = cmds
						.filter((c) => c.source === "skill")
						.map((c) => c.name)
						.join("  ");

					const t = (s: string) => truncateToWidth(s, width);
					const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
					const lk = 9; // label width
					const lines: string[] = [];

					if (prompts) {
						lines.push(t(`${pad(d("prompts"), lk)}${a(prompts)}`));
					}
					if (skills) {
						lines.push(t(`${pad(d("skills"), lk)}${a(skills)}`));
					}

					const subagents = getSubagentsHeaderSnapshot(ctx.cwd);
					lines.push(
						t(
							`${pad(d("agents"), lk)}${a(`${subagents.runningAgents} running (${subagents.runningRuns} runs) / ${subagents.availableAgents} available`)} ${d("•")} ${a("Ctrl+Alt+S /subagents-status")}`,
						),
					);
					lines.push(
						t(
							`${pad(d("running"), lk)}${a(formatAgentNameSummary(subagents.runningAgentNames))}`,
						),
					);
					lines.push(
						t(
							`${pad(d("available"), lk)}${a(formatAgentNameSummary(subagents.availableAgentNames))}`,
						),
					);

					// Add MCP server status — read live so it reflects current state
					const mcpServers = getMcpServerStatus();
					if (mcpServers.length > 0) {
						const mcpStatus = mcpServers
							.map((s) => `${s.icon} ${s.name}${s.tools !== undefined ? ` (${s.tools})` : ""}: ${s.status}`)
							.join("  ");
						lines.push(t(`${pad(d("mcp"), lk)}${a(mcpStatus)}`));
					}

					lines.push(d("─".repeat(width)));

					return lines;
				},
				// biome-ignore lint/suspicious/noEmptyBlockStatements: Required by interface
				invalidate() {},
			};
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		// Set widget initially - placed above editor for fixed position
		ctx.ui.setWidget("compact-header", createWidget(ctx), { placement: "aboveEditor" });
	});

	// Re-register widget after each turn to keep it sticky and update context
	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		ctx.ui.setWidget("compact-header", createWidget(ctx), { placement: "aboveEditor" });
	});
}
