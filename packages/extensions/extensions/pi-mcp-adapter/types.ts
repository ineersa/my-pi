import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

export type Transport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

export type ImportKind =
  | "cursor"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "windsurf"
  | "vscode";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

export type ContentBlock = TextContent | ImageContent;

export interface ServerEntry {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
}

export interface McpSettings {
  toolPrefix?: "server" | "none" | "short";
  idleTimeout?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  toonEncode?: boolean | string[];
}

export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}

export type ServerDefinition = ServerEntry;

export interface ToolMetadata {
  name: string;
  originalName: string;
  description: string;
  resourceUri?: string;
  inputSchema?: unknown;
}

export interface DirectToolSpec {
  serverName: string;
  originalName: string;
  prefixedName: string;
  description: string;
  inputSchema?: unknown;
  resourceUri?: string;
}

export interface ServerProvenance {
  path: string;
  kind: "user" | "project" | "import";
  importKind?: string;
}

export function getServerPrefix(
  serverName: string,
  mode: "server" | "none" | "short",
): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  return serverName.replace(/-/g, "_");
}

export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: "server" | "none" | "short",
): string {
  const p = getServerPrefix(serverName, prefix);
  return p ? `${p}_${toolName}` : toolName;
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: "server" | "none" | "short",
  excludeTools?: unknown,
): boolean {
  if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;

  const candidates = new Set<string>([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
  ]);

  for (const excluded of excludeTools) {
    if (typeof excluded !== "string") continue;
    if (candidates.has(normalizeToolName(excluded))) {
      return true;
    }
  }

  return false;
}
