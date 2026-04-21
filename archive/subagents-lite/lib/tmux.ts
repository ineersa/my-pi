/**
 * tmux command helpers for subagents-lite.
 */

import { spawnSync } from "node:child_process";
import type { TmuxPaneTarget } from "../types.js";

export interface TmuxResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

export function tmux(args: string[]): TmuxResult {
	const res = spawnSync("tmux", args, {
		encoding: "utf8",
	});
	const stdout = res.stdout ?? "";
	const stderr = res.stderr ?? "";
	const ok = !res.error && res.status === 0;
	return {
		ok,
		stdout,
		stderr,
		status: res.status,
		error: res.error as Error | undefined,
	};
}

export function tmuxOrThrow(args: string[]): string {
	const result = tmux(args);
	if (result.ok) return result.stdout.trim();
	if (result.error) {
		throw new Error(`Failed to run tmux ${args.join(" ")}: ${result.error.message}`);
	}
	const details = (result.stderr || result.stdout || "unknown tmux error").trim();
	throw new Error(`tmux ${args.join(" ")} failed: ${details}`);
}

export function isTmuxAvailable(): boolean {
	return tmux(["-V"]).ok;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parsePaneDescriptor(value: string): TmuxPaneTarget {
	const [paneIdRaw, windowIdRaw, sessionNameRaw] = value.split("|");
	const paneId = (paneIdRaw ?? "").trim();
	if (!paneId) {
		throw new Error(`tmux returned invalid pane descriptor: ${value}`);
	}
	const windowId = (windowIdRaw ?? "").trim() || undefined;
	const sessionName = (sessionNameRaw ?? "").trim() || undefined;
	return { paneId, windowId, sessionName };
}

/**
 * In an attached tmux client, split the current pane horizontally and place
 * subagents in a right-side vertical stack for live observability.
 */
export function createSidecarPaneStack(count: number): TmuxPaneTarget[] {
	const n = Math.max(1, Math.min(4, Math.floor(count) || 1));
	const format = "#{pane_id}|#{window_id}|#{session_name}";
	const preferredPane = process.env.TMUX_PANE?.trim();
	const current = parsePaneDescriptor(
		preferredPane
			? tmuxOrThrow(["display-message", "-p", "-t", preferredPane, format])
			: tmuxOrThrow(["display-message", "-p", format]),
	);

	const panes: TmuxPaneTarget[] = [];
	const first = parsePaneDescriptor(
		tmuxOrThrow([
			"split-window",
			"-d",
			"-h",
			"-t",
			current.paneId,
			"-P",
			"-F",
			format,
			"bash",
		]),
	);
	panes.push(first);

	for (let i = 1; i < n; i++) {
		const created = parsePaneDescriptor(
			tmuxOrThrow([
				"split-window",
				"-d",
				"-v",
				"-t",
				first.paneId,
				"-P",
				"-F",
				format,
				"bash",
			]),
		);
		panes.push(created);
	}

	if (current.windowId) {
		tmux(["select-layout", "-t", current.windowId, "main-vertical"]);
		tmux(["select-pane", "-t", current.paneId]);
	}

	return panes;
}

export function sendCtrlCToPane(paneId: string): boolean {
	return tmux(["send-keys", "-t", paneId, "C-c"]).ok;
}

export function killPane(paneId: string): boolean {
	return tmux(["kill-pane", "-t", paneId]).ok;
}

export function paneExists(paneId: string): boolean {
	const out = tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
	return out.ok && out.stdout.trim() === paneId;
}

export function startPaneLogPipe(paneId: string, logPath: string): boolean {
	return tmux([
		"pipe-pane",
		"-o",
		"-t",
		paneId,
		`cat >> ${shellQuote(logPath)}`,
	]).ok;
}

export function stopPaneLogPipe(paneId: string): boolean {
	return tmux(["pipe-pane", "-t", paneId]).ok;
}

/**
 * Jump current client to the given pane.
 * If window/session are known, use them to make cross-window jumps reliable.
 */
export function switchClientToPane(
	paneId: string,
	windowId?: string,
	sessionName?: string,
): boolean {
	if (!process.env.TMUX) return false;

	if (sessionName) {
		tmux(["switch-client", "-t", sessionName]);
	}
	if (windowId) {
		tmux(["select-window", "-t", windowId]);
	}

	const paneSelect = tmux(["select-pane", "-t", paneId]);
	if (paneSelect.ok) return true;

	if (windowId) {
		const windowSelect = tmux(["select-window", "-t", windowId]);
		if (windowSelect.ok) return true;
	}

	return false;
}

export function getPanePid(paneId: string): number | undefined {
	const out = tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
	if (!out.ok) return undefined;
	const pid = Number(out.stdout.trim());
	if (!Number.isFinite(pid) || pid <= 0) return undefined;
	return pid;
}
