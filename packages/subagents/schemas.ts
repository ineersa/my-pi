/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "@sinclair/typebox";

// Note: Using Type.Any() for Google API compatibility (doesn't support anyOf)
const SkillOverride = Type.Any({ description: "Skill name(s) to inject (comma-separated), array of strings, or boolean (false disables, true uses default)" });

export const TaskItem = Type.Object({ 
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	model: Type.Optional(Type.String({ description: "Override model for this task (e.g. 'google/gemini-3-pro')" })),
	skill: Type.Optional(SkillOverride),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode)" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: [{agent, task, count?}, ...]" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or 4." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "'fresh' (default) or 'fork' to branch from parent session",
	})),

	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution (default: false, implies sync mode)." })),
	// Solo agent overrides
	output: Type.Optional(Type.Any({ description: "Output file for single agent (string), or false to disable. Relative paths resolve against cwd." })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')" })),
});
