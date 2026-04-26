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
import { discoverAvailableAgentNames } from "./lib/agent-discovery.js";

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
	availableAgentNames: string[];
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
		availableAgentNames = discoverAvailableAgentNames(cwd).sort((a, b) => a.localeCompare(b));
		availableAgents = availableAgentNames.length;
	} catch {
		availableAgentNames = [];
		availableAgents = 0;
	}

	const snapshot = {
		availableAgents,
		availableAgentNames,
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
					const hasPrompts = cmds.some((c) => c.source === "prompt");
					const hasSkills = cmds.some((c) => c.source === "skill");

					const lk = 9; // label column width
					const lines: string[] = [];

					// Wrap a label + items across multiple lines if needed.
					// First line: "label   item1  item2", continuation: "         item3  item4"
					// Each item is individually styled so colors survive line breaks.
					function wrapLabel(label: string, items: string[]): void {
						const labelPad = label + " ".repeat(Math.max(0, lk - visibleWidth(label)));
						const indent = " ".repeat(lk);

						let first = true;
						let currentLine = "";
						let currentWidth = 0;
						const prefixWidth = first ? visibleWidth(labelPad) : lk;

						for (const item of items) {
							const itemWidth = visibleWidth(item);
							const gapWidth = currentLine ? 2 : 0;
							const totalWidth = prefixWidth + currentWidth + gapWidth + itemWidth;

							if (totalWidth <= width) {
								currentLine += (currentLine ? "  " : "") + item;
								currentWidth += gapWidth + itemWidth;
							} else {
								if (currentLine) {
									lines.push(truncateToWidth((first ? labelPad : indent) + currentLine, width));
									first = false;
								}
								currentLine = item;
								currentWidth = itemWidth;
							}
						}
						if (currentLine) {
							lines.push(truncateToWidth((first ? labelPad : indent) + currentLine, width));
						}
					}

					if (hasPrompts) {
						const promptItems = cmds
							.filter((c) => c.source === "prompt")
							.map((c) => a(`/${c.name}`));
						wrapLabel(d("prompts"), promptItems);
					}
					if (hasSkills) {
						const skillItems = cmds
							.filter((c) => c.source === "skill")
							.map((c) => a(c.name));
						wrapLabel(d("skills"), skillItems);
					}

					const subagents = getSubagentsHeaderSnapshot(ctx.cwd);
					lines.push(
						truncateToWidth(
							`${d("agents") + " ".repeat(Math.max(0, lk - 4))}${a(`${subagents.availableAgents} available`)} ${d("•")} ${a("/agents or /subagents-status")}`,
							width,
						),
					);
					if (subagents.availableAgentNames.length > 0) {
						const agentItems = formatAgentNameSummary(subagents.availableAgentNames)
							.split(", ")
							.map((s) => a(s));
						wrapLabel(d("available"), agentItems);
					}

					// Add MCP server status — read live so it reflects current state
					const mcpServers = getMcpServerStatus();
					if (mcpServers.length > 0) {
						const mcpItems = mcpServers
							.map((s) => a(`${s.icon} ${s.name}${s.tools !== undefined ? ` (${s.tools})` : ""}: ${s.status}`));
						wrapLabel(d("mcp"), mcpItems);
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
