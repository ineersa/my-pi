/**
 * TypeBox schema for the launch_subagents tool.
 */

import { Type } from "@sinclair/typebox";

export const LaunchSubagentsParams = Type.Object({
	agents: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 1,
		description:
			"Exactly one agent name to launch per call (e.g. ['scout']). To run multiple agents, issue multiple tool calls (they may run in parallel).",
	}),
	task: Type.String({
		description: "The task description for the agent.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (default: current cwd)" }),
	),
	modelOverride: Type.Optional(
		Type.String({
			description:
				"Override model for all agents (e.g. 'anthropic/claude-sonnet-4')",
		}),
	),
});
