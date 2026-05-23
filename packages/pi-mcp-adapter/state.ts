import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpLifecycleManager } from "./lifecycle.js";
import type { McpServerManager } from "./server-manager.js";
import type { ToolMetadata, McpConfig } from "./types.js";
import type { McpStatsTracker } from "./stats.js";

export interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;
  config: McpConfig;
  failureTracker: Map<string, number>;
  statsTracker?: McpStatsTracker;
  ui?: ExtensionContext["ui"];
  /** Names of MCP tool names (prefixed) that bypass ToolSearch and are always active */
  directToolNames: string[];
}
