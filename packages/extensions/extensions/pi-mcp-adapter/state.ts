import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpLifecycleManager } from "./lifecycle.js";
import type { McpServerManager } from "./server-manager.js";
import type { ToolMetadata, McpConfig } from "./types.js";

export interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;
  config: McpConfig;
  failureTracker: Map<string, number>;
  ui?: ExtensionContext["ui"];
}
