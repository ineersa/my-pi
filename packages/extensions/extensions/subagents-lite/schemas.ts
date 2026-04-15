/**
 * TypeBox schema for the launch_subagents tool.
 */

import { Type } from "@sinclair/typebox";

export const LaunchSubagentsParams = Type.Object({
	agents: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Agent names to launch (duplicates allowed, e.g. ['scout','scout','researcher']). Max 4 total.",
	}),
	task: Type.String({
		description: "The task description for all agents.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (default: current cwd)" }),
	),
	parallel: Type.Optional(
		Type.Boolean({
			description: "Run agents in parallel (default: true)",
		}),
	),
	maxConcurrency: Type.Optional(
		Type.Number({
			description: "Max concurrent agents, clamped 1-4 (default: 4)",
		}),
	),
	modelOverride: Type.Optional(
		Type.String({
			description:
				"Override model for all agents (e.g. 'anthropic/claude-sonnet-4')",
		}),
	),
});
