/**
 * Shared intercom protocol for subagents-lite parent/child communication.
 */

export const SUBAGENT_INTERCOM_PREFIX = "PI_SUBAGENTS_EVENT:";

export type SubagentIntercomEventKind = "report" | "error";

export interface SubagentIntercomEvent {
	source: "subagents-lite";
	version: 1;
	kind: SubagentIntercomEventKind;
	runId: string;
	stepIndex: number;
	label: string;
	agent?: string;
	report?: string;
	error?: string;
	timestamp: number;
}

export function encodeSubagentIntercomEvent(event: SubagentIntercomEvent): string {
	return `${SUBAGENT_INTERCOM_PREFIX}${JSON.stringify(event)}`;
}

export function decodeSubagentIntercomEvent(text: string): SubagentIntercomEvent | null {
	if (!text.startsWith(SUBAGENT_INTERCOM_PREFIX)) {
		return null;
	}
	const payload = text.slice(SUBAGENT_INTERCOM_PREFIX.length);
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const event = parsed as Partial<SubagentIntercomEvent>;
	if (event.source !== "subagents-lite" || event.version !== 1) return null;
	if (event.kind !== "report" && event.kind !== "error") {
		return null;
	}
	if (typeof event.runId !== "string" || !event.runId) return null;
	if (typeof event.stepIndex !== "number" || !Number.isInteger(event.stepIndex)) {
		return null;
	}
	if (typeof event.label !== "string" || !event.label) return null;
	if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) {
		return null;
	}
	if (event.report !== undefined && typeof event.report !== "string") return null;
	if (event.error !== undefined && typeof event.error !== "string") return null;
	if (event.agent !== undefined && typeof event.agent !== "string") return null;
	return event as SubagentIntercomEvent;
}
