import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface ForkConfig {
  /**
   * Extensions to load in child fork processes.
   * - null: load normal Pi extensions from settings/auto-discovery
   * - []: load no extensions
   * - non-empty: load only these extension sources
   */
  extensions: string[] | null;

  /** Environment variables to overlay onto child fork processes. */
  environment: Record<string, string>;

  /** Show fork cost as an extra footer status line. */
  costFooter: boolean;

  /** Default model to use for fork children (e.g. "anthropic/claude-sonnet-4"). */
  defaultModel?: string;

  /** Default thinking level for fork children. */
  defaultThinking?: string;
}

const SETTINGS_KEY = "pi-fork";

export const DEFAULT_CONFIG: ForkConfig = {
  extensions: null,
  environment: {},
  costFooter: true,
};

function isPackageSource(value: string): boolean {
  return value.startsWith("npm:") || value.startsWith("git:");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (!value) return value;
  if (isPackageSource(value)) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

function parseExtensions(raw: unknown, baseDir: string): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;

  const extensions: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    extensions.push(resolveConfiguredPath(trimmed, baseDir));
  }
  return extensions;
}

function defineEnvironmentValue(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyEnvironment(source: Record<string, string> | undefined): Record<string, string> {
  const target: Record<string, string> = {};
  if (!source) return target;

  for (const [key, value] of Object.entries(source)) {
    defineEnvironmentValue(target, key, value);
  }
  return target;
}

export function parseEnvironment(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const environment: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof rawValue !== "string" ||
      rawValue.includes("\0")
    ) {
      continue;
    }
    defineEnvironmentValue(environment, key, rawValue);
  }
  return environment;
}

export function mergeEnvironment(
  base: Record<string, string> | undefined,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const environment = copyEnvironment(base);
  if (!overrides) return environment;

  for (const [overrideKey, overrideValue] of Object.entries(overrides)) {
    defineEnvironmentValue(environment, overrideKey, overrideValue);
  }
  return environment;
}

function readNamespacedConfig(settingsPath: string, baseDir: string): Partial<ForkConfig> {
  if (!existsSync(settingsPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};

    const config = nested as Record<string, unknown>;
    const extensions = parseExtensions(config.extensions, baseDir);
    const environment = parseEnvironment(config.environment);
    const parsed: Partial<ForkConfig> = {};
    if (extensions !== undefined) parsed.extensions = extensions;
    if (environment !== undefined) parsed.environment = environment;
    if (typeof config.costFooter === "boolean") parsed.costFooter = config.costFooter;
    if (typeof config.defaultModel === "string") parsed.defaultModel = config.defaultModel;
    if (
      typeof config.defaultThinking === "string" &&
      (VALID_THINKING_LEVELS as readonly string[]).includes(config.defaultThinking)
    ) {
      parsed.defaultThinking = config.defaultThinking;
    }
    return parsed;
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): ForkConfig {
  const agentDir = getAgentDir();
  const globalPath = path.join(agentDir, "settings.json");
  const projectSettingsDir = path.join(cwd, ".pi");
  const projectPath = path.join(projectSettingsDir, "settings.json");
  const globalConfig = readNamespacedConfig(globalPath, agentDir);
  const projectConfig = readNamespacedConfig(projectPath, projectSettingsDir);

  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    environment: mergeEnvironment(globalConfig.environment, projectConfig.environment),
  };
}
