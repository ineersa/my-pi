/**
 * Prompt Channels Extension
 *
 * Relocates AGENTS.md/project-context content and skills registry from the
 * system prompt to user-level custom messages while keeping tiny system-level
 * hints about where those channels live.
 *
 * Compatible with pi-coding-agent >= 0.67.1. If newer runtimes expose
 * `event.systemPromptOptions`, this extension uses them as the source of truth;
 * otherwise it falls back to parsing the assembled system prompt string.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "prompt-channels";

const PROJECT_CONTEXT_ANCHOR = "# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_INTRO_LINES = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
] as const;
const SKILLS_START_MARKER = `${SKILLS_INTRO_LINES.join("\n")}\n\n<available_skills>`;
const SKILLS_END_TAG = "</available_skills>";
const SYSTEM_HINTS = [
	"## Context Channels",
	"- Project/repository instructions may appear in tagged user-context messages with `<INSTRUCTIONS>` blocks.",
	"- Available skills may appear in tagged reminder messages with `<available_skills>`; use them instead of guessing.",
].join("\n");

interface ContextFileLike {
	path: string;
	content: string;
}

interface SkillLike {
	name: string;
	description: string;
	filePath?: string;
	location?: string;
	disableModelInvocation?: boolean;
}

interface SystemPromptOptionsLike {
	contextFiles?: ContextFileLike[];
	skills?: SkillLike[];
}

interface ChannelsState {
	lastContextHash: string | undefined;
	lastSkillsHash: string | undefined;
	lastCwd: string | undefined;
	pendingReinject: boolean;
	/** When true, the conversation already has a prompt-channels message from a
	 *  prior session (resume/fork). The first before_agent_start should save
	 *  hashes but skip injection. */
	skipInitialInject: boolean;
}

interface MessageLike {
	role: string;
	customType?: string;
}

function createState(): ChannelsState {
	return {
		lastContextHash: undefined,
		lastSkillsHash: undefined,
		lastCwd: undefined,
		pendingReinject: true,
		skipInitialInject: false,
	};
}

function simpleHash(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function hashContent(content: string | null): string {
	return content ? simpleHash(content) : "";
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function getSystemPromptOptions(event: unknown): SystemPromptOptionsLike | undefined {
	const options = (event as { systemPromptOptions?: unknown }).systemPromptOptions;
	if (!options || typeof options !== "object") return undefined;
	return options as SystemPromptOptionsLike;
}

function formatContextFilesFromOptions(contextFiles: ContextFileLike[] | undefined): string | null {
	if (!contextFiles || contextFiles.length === 0) return null;
	return contextFiles.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
}

function formatSkillsFromOptions(skills: SkillLike[] | undefined): string | null {
	const visibleSkills = (skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return null;

	const lines = [...SKILLS_INTRO_LINES, "", "<available_skills>"];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath ?? skill.location ?? "")}</location>`);
		lines.push("  </skill>");
	}
	lines.push(SKILLS_END_TAG);

	return lines.join("\n");
}

function getProjectContextRange(prompt: string): { start: number; end: number } | null {
	const anchorIndex = prompt.indexOf(PROJECT_CONTEXT_ANCHOR);
	if (anchorIndex === -1) return null;

	const contentStart = anchorIndex + PROJECT_CONTEXT_ANCHOR.length;
	const dateIndex = prompt.indexOf("\n\nCurrent date:", contentStart);
	const skillsIndex = prompt.indexOf(`\n\n${SKILLS_INTRO_LINES[0]}`, contentStart);

	let end = prompt.length;
	if (dateIndex !== -1 && dateIndex < end) end = dateIndex;
	if (skillsIndex !== -1 && skillsIndex < end) end = skillsIndex;

	const start = anchorIndex >= 2 && prompt.slice(anchorIndex - 2, anchorIndex) === "\n\n" ? anchorIndex - 2 : anchorIndex;
	return { start, end };
}

function extractProjectContext(prompt: string): string | null {
	const range = getProjectContextRange(prompt);
	if (!range) return null;
	return prompt.slice(range.start, range.end).replace(/^\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n/, "");
}

function getSkillsRange(prompt: string): { start: number; end: number } | null {
	const startIndex = prompt.indexOf(SKILLS_START_MARKER);
	if (startIndex === -1) return null;

	const endIndex = prompt.indexOf(SKILLS_END_TAG, startIndex);
	if (endIndex === -1) return null;

	const start = startIndex >= 2 && prompt.slice(startIndex - 2, startIndex) === "\n\n" ? startIndex - 2 : startIndex;
	return { start, end: endIndex + SKILLS_END_TAG.length };
}

function extractSkillsSection(prompt: string): string | null {
	const range = getSkillsRange(prompt);
	if (!range) return null;
	return prompt.slice(range.start, range.end).trim();
}

function stripRange(prompt: string, range: { start: number; end: number } | null): string {
	if (!range) return prompt;
	return prompt.slice(0, range.start) + prompt.slice(range.end);
}

function injectSystemHints(prompt: string): string {
	if (prompt.includes("## Context Channels")) return prompt;
	const dateAnchor = "\n\nCurrent date:";
	const dateIndex = prompt.indexOf(dateAnchor);
	const block = `\n\n${SYSTEM_HINTS}`;
	if (dateIndex === -1) return `${prompt}${block}`;
	return `${prompt.slice(0, dateIndex)}${block}${prompt.slice(dateIndex)}`;
}

function stripPrompt(prompt: string): string {
	let result = prompt;
	const projectRange = getProjectContextRange(result);
	if (projectRange) result = stripRange(result, projectRange);
	const skillsRange = getSkillsRange(result);
	if (skillsRange) result = stripRange(result, skillsRange);
	if (projectRange || skillsRange) result = injectSystemHints(result);
	return result;
}

function formatContextMessage(contextContent: string, cwd: string): string {
	if (!contextContent.trim()) return "";
	return [
		`# AGENTS.md instructions for ${cwd}`,
		"",
		"<INSTRUCTIONS>",
		contextContent.trimEnd(),
		"</INSTRUCTIONS>",
	].join("\n");
}

function formatSkillsMessage(skillsContent: string): string {
	if (!skillsContent.trim()) return "";
	return ["<skills_instructions>", skillsContent.trim(), "</skills_instructions>"].join("\n");
}

function buildCombinedMessage(contextContent: string | null, skillsContent: string | null, cwd: string): string {
	const parts: string[] = [];

	if (contextContent?.trim()) {
		parts.push(formatContextMessage(contextContent, cwd));
	}

	if (skillsContent?.trim()) {
		parts.push(formatSkillsMessage(skillsContent));
	}

	return parts.join("\n\n---\n\n");
}

function isPromptChannelsMessage(message: MessageLike): boolean {
	return message.role === "custom" && message.customType === CUSTOM_TYPE;
}

function findPreviousUserIndex(messages: MessageLike[], startIndex: number): number {
	for (let i = startIndex - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

function reorderPromptChannelsBeforeUser<T extends MessageLike>(messages: T[]): T[] {
	const reordered = [...messages];
	let changed = false;

	for (let i = 0; i < reordered.length; i++) {
		const message = reordered[i];
		if (!message || !isPromptChannelsMessage(message)) continue;

		const previousUserIndex = findPreviousUserIndex(reordered, i);
		if (previousUserIndex === -1 || previousUserIndex === i) continue;

		const [promptChannelsMessage] = reordered.splice(i, 1);
		reordered.splice(previousUserIndex, 0, promptChannelsMessage);
		changed = true;
	}

	return changed ? reordered : messages;
}

function resolveContextContent(systemPrompt: string, event: unknown): string | null {
	const options = getSystemPromptOptions(event);
	if (options && "contextFiles" in options) {
		return formatContextFilesFromOptions(options.contextFiles);
	}
	return extractProjectContext(systemPrompt);
}

function resolveSkillsContent(systemPrompt: string, event: unknown): string | null {
	const options = getSystemPromptOptions(event);
	if (options && "skills" in options) {
		return formatSkillsFromOptions(options.skills);
	}
	return extractSkillsSection(systemPrompt);
}

export default function promptChannels(pi: ExtensionAPI): void {
	const state = createState();

	const RESUME_REASONS = new Set(["resume", "fork"]);

	pi.on("session_start", (event) => {
		if (RESUME_REASONS.has(event.reason)) {
			state.pendingReinject = false;
			state.skipInitialInject = true;
		}
	});

	pi.on("session_compact", () => {
		state.pendingReinject = true;
	});

	pi.on("context", (event) => {
		const reordered = reorderPromptChannelsBeforeUser(event.messages);
		return reordered === event.messages ? undefined : { messages: reordered };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { systemPrompt } = event;
		const contextContent = resolveContextContent(systemPrompt, event);
		const skillsContent = resolveSkillsContent(systemPrompt, event);

		const contextHash = hashContent(contextContent);
		const skillsHash = hashContent(skillsContent);
		const cwdChanged = ctx.cwd !== state.lastCwd;
		const shouldReinject =
			state.pendingReinject ||
			contextHash !== state.lastContextHash ||
			skillsHash !== state.lastSkillsHash ||
			cwdChanged;

		const modifiedPrompt = stripPrompt(systemPrompt);

		state.lastContextHash = contextHash;
		state.lastSkillsHash = skillsHash;
		state.lastCwd = ctx.cwd;

		// On resume/fork the conversation already contains our custom message.
		// Save hashes so future changes are detected, but skip injection.
		if (state.skipInitialInject) {
			state.skipInitialInject = false;
			return modifiedPrompt === systemPrompt ? undefined : { systemPrompt: modifiedPrompt };
		}

		if (!shouldReinject) {
			state.pendingReinject = false;
			return modifiedPrompt === systemPrompt ? undefined : { systemPrompt: modifiedPrompt };
		}

		state.pendingReinject = false;
		const messageContent = buildCombinedMessage(contextContent, skillsContent, ctx.cwd);
		if (!messageContent.trim()) {
			return modifiedPrompt === systemPrompt ? undefined : { systemPrompt: modifiedPrompt };
		}

		return {
			systemPrompt: modifiedPrompt,
			message: {
				customType: CUSTOM_TYPE,
				content: messageContent,
				display: true,
				details: {},
			},
		};
	});
}
