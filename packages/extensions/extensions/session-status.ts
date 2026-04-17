import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSIONS_PACKAGE_DOCS_INDEX = resolve(__dirname, "..", "docs", "ai-index.json");

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
    const nudge = `Before changing behavior, read this package docs index: ${EXTENSIONS_PACKAGE_DOCS_INDEX}; then read the target entity's settings.md + maintenance.md.`;
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
