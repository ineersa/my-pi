import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands/register-commands";
import { registerEvents } from "./events/register-events";
import { createRuntimeServices } from "./runtime/session-state";

export default function compactionPolicyExtension(pi: ExtensionAPI) {
	const runtime = createRuntimeServices();
	registerCommands(pi, runtime);
	registerEvents(pi, runtime);
}
