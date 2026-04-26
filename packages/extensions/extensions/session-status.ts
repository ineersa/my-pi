import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSIONS_PACKAGE_DOCS_INDEX = resolve(__dirname, "..", "docs", "ai-index.json");
const EXTENSIONS_ENTITY_NAMES = [
	"safe-guard",
	"bg-process",
	"compact-header",
	"focus-cursor",
	"custom-footer",
	"skill-palette",
	"rewind",
	"session-status",
	"usage",
	"pi-mcp-adapter",
	"subagents",
	"intercom",
	"custom-compaction",
	"output-cap",
	"ide",
];

export default function sessionStatusExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus("my-pi", `my-pi: ${event.reason}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus("my-pi", undefined);
  });

  pi.on("before_agent_start", async (event) => {
    const nudge = [
      `Extension docs guard: only read ${EXTENSIONS_PACKAGE_DOCS_INDEX} and the target entity's settings.md + maintenance.md when:`,
      `- You intend to modify one of these extensions: ${EXTENSIONS_ENTITY_NAMES.join(", ")}.`,
      "- The user asks about how to configure or use one of these extensions.",
      "Otherwise do NOT read these docs.",
    ].join("\n");
    return {
      systemPrompt: `${event.systemPrompt}\n\n${nudge}`,
    };
  });

  pi.registerCommand("my-pi", {
    description: "Show my-pi bundle status",
    handler: async (_args, ctx) => {
      const extensionCommands = pi
        .getCommands()
        .filter((command) => command.source === "extension").length;
      ctx.ui.notify(`my-pi loaded. Extension commands available: ${extensionCommands}`, "info");
    },
  });
}
