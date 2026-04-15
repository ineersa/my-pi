import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function sessionStatusExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus("my-pi", `my-pi: ${event.reason}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus("my-pi", undefined);
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
