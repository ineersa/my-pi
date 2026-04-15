/**
 * Shared TUI rendering helpers for subagents-lite overlays.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	return (
		theme.fg("border", "│") +
		pad(content, innerW) +
		theme.fg("border", "│")
	);
}

export function renderHeader(
	text: string,
	width: number,
	theme: Theme,
): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function renderFooter(
	text: string,
	width: number,
	theme: Theme,
): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatTokens(n: number): string {
	return n < 1000
		? String(n)
		: n < 10000
			? `${(n / 1000).toFixed(1)}k`
			: `${Math.round(n / 1000)}k`;
}

// ─── Fuzzy filter ───────────────────────────────────────────────────────

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<
	T extends { name: string; description: string; model?: string },
>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({
			item,
			score: Math.max(
				fuzzyScore(q, item.name),
				fuzzyScore(q, item.description) * 0.8,
				fuzzyScore(q, item.model ?? "") * 0.6,
			),
		}))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}
