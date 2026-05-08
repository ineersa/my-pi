/**
 * Behavior resolution for parallel execution
 */

import type { AgentConfig } from "./agents.ts";

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
	output: string | false;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective behavior for a step/parallel task.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	sharedSkills?: string[],
): ResolvedStepBehavior {
	const output =
		stepOverrides.output !== undefined
			? stepOverrides.output
			: agentConfig.output ?? false;

	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (sharedSkills && sharedSkills.length > 0) {
			skills = [...new Set([...skills, ...sharedSkills])];
		}
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
		if (sharedSkills && sharedSkills.length > 0) {
			skills = [...new Set([...skills, ...sharedSkills])];
		}
	}

	const model = stepOverrides.model ?? agentConfig.model;
	return { output, reads, progress, skills, model };
}
