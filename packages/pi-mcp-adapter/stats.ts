import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { logger } from "./logger.js";
import type { McpCaptureStatsSettings, McpConfig } from "./types.js";

const STATS_VERSION = 1;
const DEFAULT_STATS_PATH = ".pi/mcp-tool-stats.json";
const DEFAULT_FLUSH_DELAY_MS = 750;

type CallMode = "proxy" | "direct";
type CallOutcome = "success" | "error";

export interface ToolCallEvent {
  serverName: string;
  toolName: string;
  mode: CallMode;
  outcome: CallOutcome;
  errorCode?: string;
}

interface ToolStats {
  calls: number;
  success: number;
  errors: number;
  proxyCalls: number;
  directCalls: number;
  errorCodes: Record<string, number>;
  lastCalledAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

interface ServerStats {
  calls: number;
  success: number;
  errors: number;
  proxyCalls: number;
  directCalls: number;
  tools: Record<string, ToolStats>;
  lastCalledAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

interface McpToolStatsSnapshot {
  version: number;
  updatedAt: string;
  projectRoot: string;
  servers: Record<string, ServerStats>;
}

export class McpStatsTracker {
  private readonly filePath: string;
  private readonly flushDelayMs: number;
  private snapshot: McpToolStatsSnapshot;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string, filePath: string, flushDelayMs: number) {
    this.filePath = filePath;
    this.flushDelayMs = flushDelayMs;
    this.snapshot = this.loadExisting(projectRoot) ?? {
      version: STATS_VERSION,
      updatedAt: new Date().toISOString(),
      projectRoot,
      servers: {},
    };
  }

  record(event: ToolCallEvent): void {
    if (!event.serverName || !event.toolName) return;

    const now = new Date().toISOString();

    const serverStats = this.snapshot.servers[event.serverName] ?? {
      calls: 0,
      success: 0,
      errors: 0,
      proxyCalls: 0,
      directCalls: 0,
      tools: {},
      lastCalledAt: now,
    };

    serverStats.calls += 1;
    if (event.mode === "proxy") {
      serverStats.proxyCalls += 1;
    } else {
      serverStats.directCalls += 1;
    }
    serverStats.lastCalledAt = now;

    if (event.outcome === "success") {
      serverStats.success += 1;
      serverStats.lastSuccessAt = now;
    } else {
      serverStats.errors += 1;
      serverStats.lastErrorAt = now;
    }

    const toolStats = serverStats.tools[event.toolName] ?? {
      calls: 0,
      success: 0,
      errors: 0,
      proxyCalls: 0,
      directCalls: 0,
      errorCodes: {},
      lastCalledAt: now,
    };

    toolStats.calls += 1;
    if (event.mode === "proxy") {
      toolStats.proxyCalls += 1;
    } else {
      toolStats.directCalls += 1;
    }
    toolStats.lastCalledAt = now;

    if (event.outcome === "success") {
      toolStats.success += 1;
      toolStats.lastSuccessAt = now;
    } else {
      toolStats.errors += 1;
      toolStats.lastErrorAt = now;
      if (event.errorCode) {
        toolStats.errorCodes[event.errorCode] = (toolStats.errorCodes[event.errorCode] ?? 0) + 1;
      }
    }

    serverStats.tools[event.toolName] = toolStats;
    this.snapshot.servers[event.serverName] = serverStats;
    this.snapshot.updatedAt = now;

    this.scheduleFlush();
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeSnapshot();
  }

  dispose(): void {
    this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeSnapshot();
    }, this.flushDelayMs);

    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  private writeSnapshot(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.snapshot, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`MCP: failed to write tool stats file: ${message}`);
    }
  }

  private loadExisting(projectRoot: string): McpToolStatsSnapshot | null {
    if (!existsSync(this.filePath)) return null;

    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!raw || typeof raw !== "object") return null;
      if (raw.version !== STATS_VERSION) return null;
      if (!raw.servers || typeof raw.servers !== "object") return null;

      return {
        version: STATS_VERSION,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
        projectRoot: typeof raw.projectRoot === "string" ? raw.projectRoot : projectRoot,
        servers: raw.servers as Record<string, ServerStats>,
      };
    } catch {
      return null;
    }
  }
}

export function createStatsTracker(config: McpConfig, projectRoot: string): McpStatsTracker | undefined {
  const setting = config.settings?.captureStats;
  if (!setting) return undefined;

  let filePath = DEFAULT_STATS_PATH;
  let flushDelayMs = DEFAULT_FLUSH_DELAY_MS;

  if (typeof setting === "object" && setting !== null && !Array.isArray(setting)) {
    const capture = setting as McpCaptureStatsSettings;
    if (typeof capture.path === "string" && capture.path.trim().length > 0) {
      filePath = capture.path.trim();
    }
    if (typeof capture.flushDelayMs === "number" && Number.isFinite(capture.flushDelayMs)) {
      flushDelayMs = Math.max(50, Math.floor(capture.flushDelayMs));
    }
  }

  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : resolve(projectRoot, filePath);

  return new McpStatsTracker(projectRoot, resolvedPath, flushDelayMs);
}
