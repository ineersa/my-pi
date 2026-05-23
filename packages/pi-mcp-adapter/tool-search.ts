// tool-search.ts — ToolSearch tool for discovering and activating MCP tools on demand
//
// This implements an OpenAI-style client-side ToolSearch:
// - The LLM sees ToolSearch + builtins (NOT all MCP schemas)
// - When it needs an MCP tool, it calls ToolSearch({ query: "..." })
// - ToolSearch finds matches and activates them via setActiveTools
//
// ToolSearch supports two modes: keyword search and exact "select:" prefix.

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { McpExtensionState } from "./state.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeferredTool {
  /** Prefixed name (e.g. "jetbrains_index__ide_find_definition") */
  name: string;
  /** Original MCP tool name (e.g. "ide_find_definition") */
  originalName: string;
  /** Tool description */
  description: string;
  /** Server this tool belongs to */
  serverName: string;
  /** Full JSON Schema for parameters (if available) */
  inputSchema?: unknown;
}

interface ScoredTool {
  tool: DeferredTool;
  score: number;
}

// ---------------------------------------------------------------------------
// Scoring constants for weighted search
// ---------------------------------------------------------------------------

const SCORES = {
  /** Exact match: a query term matches a part of the tool name exactly */
  exactPartMatch: 10,
  /** Sub-part match: a query term is contained in a part of the tool name */
  subPartMatch: 5,
  /** Fallback: the full tool name contains the query term */
  fullNameContains: 3,
  /** Word-boundary match in the tool description */
  descriptionMatch: 4,
} as const;

const MAX_RESULTS = 5;

// ---------------------------------------------------------------------------
// Tool name parsing
// ---------------------------------------------------------------------------

/**
 * Parse a tool name (using `__` as server/tool separator) into lowercase parts.
 *
 * "jetbrains_index__ide_find_definition"
 * → server prefix: "jetbrains_index"
 * → tool parts: ["ide", "find", "definition"]
 *
 * The server prefix is stripped; only the tool-name segment is split on `_`.
 */
export function parseToolNameParts(name: string): string[] {
  const lower = name.toLowerCase();
  // Split on __ to get [serverPrefix, toolName]
  const segments = lower.split("__");
  const toolPart = segments.length > 1 ? segments.slice(1).join("__") : segments[0];
  return toolPart.split("_").filter(p => p.length > 0);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Weighted keyword search over deferred tools.
 * Returns up to MAX_RESULTS matches sorted by relevance.
 */
export function searchByKeywords(
  query: string,
  deferredTools: DeferredTool[],
): DeferredTool[] {
  const queryLower = query.toLowerCase().trim();

  // Fast path: exact tool name match (case-insensitive)
  const exactMatch = deferredTools.find(
    t => t.name.toLowerCase() === queryLower
         || t.originalName.toLowerCase() === queryLower,
  );
  if (exactMatch) return [exactMatch];

  // Tokenize query into terms
  const terms = queryLower.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  // Compile word-boundary patterns for description matching
  const termPatterns = new Map<string, RegExp>();
  for (const term of terms) {
    termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"));
  }

  // Score each deferred tool
  const scored: ScoredTool[] = [];
  for (const tool of deferredTools) {
    let score = 0;
    const nameParts = parseToolNameParts(tool.name);
    const descriptionLower = (tool.description || "").toLowerCase();

    for (const term of terms) {
      // Name match: exact part
      if (nameParts.includes(term)) {
        score += SCORES.exactPartMatch;
        continue;
      }
      // Name match: sub-part
      if (nameParts.some(p => p.includes(term))) {
        score += SCORES.subPartMatch;
        continue;
      }
      // Name match: full name contains (fallback)
      if (tool.name.toLowerCase().includes(term)) {
        score += SCORES.fullNameContains;
        continue;
      }
      // Description word-boundary match
      const pattern = termPatterns.get(term)!;
      if (pattern.test(descriptionLower)) {
        score += SCORES.descriptionMatch;
      }
    }

    if (score > 0) scored.push({ tool, score });
  }

  // Sort descending by score, cap at MAX_RESULTS
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map(s => s.tool);
}



// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Activate the found tools by adding them to the active tool set.
 * Returns a result message describing what was loaded.
 */
export function loadAndActivate(
  pi: ExtensionAPI,
  toolNames: string[],
  deferredTools: DeferredTool[],
): AgentToolResult<Record<string, unknown>> {
  const found: DeferredTool[] = [];
  const notFound: string[] = [];

  for (const name of toolNames) {
    const tool = deferredTools.find(
      t => t.name === name || t.originalName === name,
    );
    if (tool) found.push(tool);
    else notFound.push(name);
  }

  if (found.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No tools found for: ${toolNames.join(", ")}. Use ToolSearch with keywords to search.`,
      }],
      details: {},
    };
  }

  // Activate found tools
  const currentActive = pi.getActiveTools();
  const toActivate = found.map(t => t.name);
  const newActive = [...new Set([...currentActive, ...toActivate])];
  pi.setActiveTools(newActive);

  // Build response: names + descriptions only (2-turn pattern).
  // Full schemas appear next turn when tool is in the active set.
  let text = `Loaded ${found.length} MCP tool${found.length > 1 ? "s" : ""}. You can call them next turn with typed parameters:\n\n`;
  for (const tool of found) {
    const shortDesc = (tool.description || "").split("\n")[0].slice(0, 120);
    text += `- **${tool.name}**: ${shortDesc}\n`;
  }

  if (notFound.length > 0) {
    text += `\nNot found: ${notFound.join(", ")}\n`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { loaded: found.map(t => t.name), notFound },
  };
}

// ---------------------------------------------------------------------------
// Deferred tool enumeration
// ---------------------------------------------------------------------------

/**
 * Get all registered MCP tools that are NOT direct (i.e., need ToolSearch).
 */
export function getAllDeferredTools(state: McpExtensionState): DeferredTool[] {
  const directNames = new Set(state.directToolNames);
  const deferred: DeferredTool[] = [];

  for (const [serverName, tools] of state.toolMetadata.entries()) {
    for (const tool of tools) {
      // tool.name is already prefixed by buildToolMetadata() — do NOT re-prefix
      if (!directNames.has(tool.name)) {
        deferred.push({
          name: tool.name,
          originalName: tool.originalName,
          description: tool.description || "",
          serverName,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }

  return deferred;
}

// ---------------------------------------------------------------------------
// Catalog description
// ---------------------------------------------------------------------------

/**
 * Build the catalog description for ToolSearch — this is what the LLM sees
 * in lieu of full tool schemas. Accepts null state safely.
 */
export function buildToolSearchDescription(state: McpExtensionState | null): string {
  if (!state) {
    return "MCP not initialized. Tools will be available after session start.";
  }
  const deferred = getAllDeferredTools(state);
  let desc = `YOU MUST use ToolSearch FIRST to discover and load ANY of the MCP tools listed below. Do NOT attempt to call any of these tools by name before using ToolSearch — they are not active and will not be found.

To load a tool: search by keywords, or use "select:server__toolname" to load a specific tool by its full prefixed name.

## Available MCP tools:

`;

  // Group deferred tools by server
  const byServer = new Map<string, DeferredTool[]>();
  for (const tool of deferred) {
    const list = byServer.get(tool.serverName) ?? [];
    list.push(tool);
    byServer.set(tool.serverName, list);
  }

  if (byServer.size === 0) {
    desc += "(No deferred MCP tools available — all tools are direct or none are configured)\n";
  } else {
    for (const [serverName, tools] of byServer) {
      desc += `### ${serverName}\n`;
      for (const tool of tools) {
        desc += `- ${tool.name}\n`;
      }
      desc += "\n";
    }
  }

  desc += `## Usage:
- ToolSearch({ query: "keywords" }) — search by keywords, loads matches
- ToolSearch({ query: "select:server__toolname" }) — load specific tools by full prefixed name`;

  return desc;
}

export function buildToolSearchGuidelines(state: McpExtensionState | null): string[] {
  const deferredNames = state
    ? getAllDeferredTools(state).map(tool => tool.name).sort((a, b) => a.localeCompare(b))
    : [];

  return [
    "Use ToolSearch before calling deferred MCP tools. ToolSearch can directly load exact server__tool names.",
    "Use ToolSearch({ query: \"keywords\" }) to search, or ToolSearch({ query: \"select:server__tool1,server__tool2\" }) to load exact comma-separated tools.",
    `ToolSearch available deferred server__tool names: ${deferredNames.length > 0 ? deferredNames.join(", ") : "(none)"}`,
  ];
}

// ---------------------------------------------------------------------------
// ToolSearch tool definition
// ---------------------------------------------------------------------------

/**
 * Create the ToolSearch tool definition.
 *
 * @param getState  Function that returns the current McpExtensionState (handles lifecycle)
 * @param pi        ExtensionAPI instance for calling getActiveTools / setActiveTools
 */
export function createToolSearchTool(
  getState: () => McpExtensionState | null,
  pi: ExtensionAPI,
) {
  const state = getState();

  return {
    name: "ToolSearch",
    label: "MCP ToolSearch",
    description: buildToolSearchDescription(state),
    promptSnippet: "Search and load deferred MCP tools",
    promptGuidelines: buildToolSearchGuidelines(state),
    parameters: Type.Object({
      query: Type.String({
        description:
          'Search query. Use "select:server__toolname" to load exact tools by name '
          + "(e.g. \"select:jetbrains_index__ide_find_definition\"), "
          + "or use keywords like \"jetbrains find definition\" to search by name/description.",
      }),
    }) as any,
    async execute(
      _toolCallId: string,
      params: { query: string },
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const currentState = getState();
      if (!currentState) {
        return {
          content: [{
            type: "text" as const,
            text: "MCP not initialized. Wait for session start to complete.",
          }],
          details: {},
        };
      }

      const { query } = params;
      const deferredTools = getAllDeferredTools(currentState);

      // Parse "select:" prefix for exact tool loading
      const selectMatch = query.match(/^select:(.+)$/i);
      if (selectMatch) {
        const names = selectMatch[1].split(",").map(s => s.trim());
        return loadAndActivate(pi, names, deferredTools);
      }

      // Keyword search
      const matches = searchByKeywords(query, deferredTools);
      if (matches.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No MCP tools matching "${query}".`,
          }],
          details: {},
        };
      }

      return loadAndActivate(
        pi,
        matches.map(m => m.name),
        deferredTools,
      );
    },
  };
}
