/**
 * Core type definitions for subagents-lite
 */

// ─── Agent types ────────────────────────────────────────────────────────

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
}

// ─── Run request / result ───────────────────────────────────────────────

export type SubagentRuntime = "tmux";

export type SubagentExecutionMode = "interactive" | "orchestrated";

export interface TmuxPaneTarget {
	paneId: string;
	windowId?: string;
	sessionName?: string;
}

export interface SubagentRunRequest {
	agent: AgentConfig;
	task: string;
	runId?: string;
	cwd?: string;
	modelOverride?: string;
	index: number;
	label: string;
	parentSessionId?: string;
	parentSessionName?: string;
	parentIntercomTarget?: string;
	runtime?: SubagentRuntime;
	executionMode?: SubagentExecutionMode;
	tmuxTarget?: TmuxPaneTarget;
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SubagentRunResult {
	agent: string;
	task: string;
	label: string;
	status: "ok" | "error";
	exitCode: number;
	durationMs: number;
	output: string;
	error?: string;
	usage?: UsageSummary;
	model?: string;
	runtime?: SubagentRuntime;
	executionMode?: SubagentExecutionMode;
	logPath?: string;
	tmuxPaneId?: string;
	tmuxWindowId?: string;
	tmuxSessionName?: string;
	report?: string;
}

// ─── Parallel run ───────────────────────────────────────────────────────

export interface ParallelRunResult {
	runId: string;
	overallStatus: "ok" | "partial" | "error";
	results: SubagentRunResult[];
	durationMs: number;
}

// ─── History / status ───────────────────────────────────────────────────

export interface RunStatusStep {
	agent: string;
	label: string;
	status: "pending" | "running" | "ok" | "error";
	durationMs?: number;
	tokens?: number;
	error?: string;
	pid?: number;
	runtime?: SubagentRuntime;
	executionMode?: SubagentExecutionMode;
	logPath?: string;
	tmuxPaneId?: string;
	tmuxWindowId?: string;
	tmuxSessionName?: string;
	taskPreview?: string;
	report?: string;
	reportUpdatedAt?: number;
	configuredSkills?: string[];
	resolvedSkills?: string[];
	missingSkills?: string[];
}

export interface RunStatus {
	runId: string;
	state: "running" | "complete" | "failed";
	mode: "single" | "parallel";
	executionMode?: SubagentExecutionMode;
	ownerSessionId?: string;
	ownerSessionName?: string;
	startedAt: number;
	lastUpdate: number;
	endedAt?: number;
	cwd?: string;
	steps: RunStatusStep[];
}

// ─── Constants ──────────────────────────────────────────────────────────

export const MAX_SUBAGENTS_PER_RUN = 1;
