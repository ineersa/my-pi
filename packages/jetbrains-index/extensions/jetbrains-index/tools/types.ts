import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TObject } from "@sinclair/typebox";

/** Minimal shape for extension context used in execute(). */
export type ExecCtx = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

export type ContentBlock = { type: "text"; text: string };

export type ToolResult = {
	content: ContentBlock[];
	isError?: boolean;
};

export type ToolRegistration = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TObject;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: { aborted: boolean } | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: ExecCtx,
	) => Promise<ToolResult>;
};
