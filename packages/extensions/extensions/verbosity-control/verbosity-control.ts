/**
 * Verbosity Control Extension — per-model text verbosity for OpenAI Codex.
 *
 * Intercepts `before_provider_request` to inject `text.verbosity` into
 * OpenAI Codex payloads. This mitigates commentary-only turn stops that
 * happen when verbosity is too low for tool-calling models.
 *
 * User configuration (first match wins):
 *   1. <cwd>/.pi/verbosity-control.json
 *   2. ~/.pi/agent/verbosity-control.json
 *   3. built-in defaults
 *
 * Commands:
 *   /verbosity                   — show current verbosity per model
 *   /verbosity <level>           — set global default verbosity
 *   /verbosity <model> <level>   — set verbosity for a specific model pattern
 *
 * The config is a JSON file with:
 *   defaultVerbosity: "low" | "medium" | "high" (default "low")
 *   verbosityByModel: Record<string, "low" | "medium" | "high">
 *
 * Built-in defaults match what OpenAI Codex does upstream:
 * - gpt-5.3-codex, gpt-5.4-mini → medium
 * - gpt-5.5 → low
 * - all others → defaultVerbosity ("low")
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────

type Verbosity = "low" | "medium" | "high";

interface VerbosityConfig {
	defaultVerbosity?: Verbosity;
	verbosityByModel?: Record<string, Verbosity>;
}

type CodexPayload = {
	text?: { verbosity?: Verbosity; [key: string]: unknown };
	[key: string]: unknown;
};

// ─── Defaults & state ─────────────────────────────────────────────────────

const BUILTIN_BY_MODEL: Record<string, Verbosity> = {
	"gpt-5.3-codex": "medium",
	"gpt-5.4-mini": "medium",
	"gpt-5.5": "low",
};

const BUILTIN_DEFAULT: Verbosity = "low";

let loadedConfig: VerbosityConfig | null = null;

let settingsDir: string | null = null;

// ─── Config loading ───────────────────────────────────────────────────────

function resolveSettingsDir(): string {
	if (settingsDir) return settingsDir;
	const home = os.homedir();
	settingsDir = path.join(home, ".pi", "agent");
	return settingsDir;
}

function loadConfig(): VerbosityConfig {
	const candidates = [
		path.join(process.cwd(), ".pi", "verbosity-control.json"),
		path.join(resolveSettingsDir(), "verbosity-control.json"),
	];

	for (const file of candidates) {
		try {
			const raw = fs.readFileSync(file, "utf-8");
			const parsed = JSON.parse(raw) as VerbosityConfig;
			if (parsed.defaultVerbosity && !["low", "medium", "high"].includes(parsed.defaultVerbosity)) {
				continue;
			}
			if (parsed.verbosityByModel) {
				for (const [modelId, v] of Object.entries(parsed.verbosityByModel)) {
					if (!["low", "medium", "high"].includes(v)) {
						delete parsed.verbosityByModel[modelId];
					}
				}
			}
			return parsed;
		} catch {
			// file doesn't exist or is invalid, try next
		}
	}

	return {};
}

function getConfig(): VerbosityConfig {
	if (!loadedConfig) {
		loadedConfig = loadConfig();
	}
	return loadedConfig;
}

function invalidateConfig(): void {
	loadedConfig = null;
}

function resolveVerbosity(modelId: string): Verbosity {
	const config = getConfig();

	// 1. Per-model override from config
	if (config.verbosityByModel && modelId in config.verbosityByModel) {
		return config.verbosityByModel[modelId];
	}

	// 2. Built-in per-model
	if (modelId in BUILTIN_BY_MODEL) {
		return BUILTIN_BY_MODEL[modelId];
	}

	// 3. Config default
	if (config.defaultVerbosity) {
		return config.defaultVerbosity;
	}

	// 4. Built-in default
	return BUILTIN_DEFAULT;
}

// ─── Persist config ───────────────────────────────────────────────────────

function saveConfig(config: VerbosityConfig): void {
	const dir = resolveSettingsDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "verbosity-control.json");
	fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
	loadedConfig = config;
}

// ─── Command handler ──────────────────────────────────────────────────────

function modelMatchesId(modelId: string, pattern: string): boolean {
	// Direct match
	if (modelId === pattern) return true;
	// Wildcard match (e.g., "gpt-5*")
	if (pattern.includes("*")) {
		const re = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
		return re.test(modelId);
	}
	// Substring match
	return modelId.includes(pattern);
}

async function handleVerbosityCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.trim().split(/\s+/);

	if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
		// Show current config and active model verbosity
		const config = getConfig();
		const lines: string[] = [];
		lines.push("╭─ Verbosity Control ─────────────────────────────╮");
		lines.push("");

		const def = config.defaultVerbosity ?? BUILTIN_DEFAULT;
		lines.push(`  Default:        ${formatVerbosity(def)}`);

		// Merge built-in + user per-model overrides
		const allModels = new Set<string>([
			...Object.keys(BUILTIN_BY_MODEL),
			...Object.keys(config.verbosityByModel ?? {}),
		]);

		if (allModels.size > 0) {
			lines.push("");
			lines.push("  Per-model:");
			for (const modelId of [...allModels].sort()) {
				const resolved = resolveVerbosity(modelId);
				const source = modelId in (config.verbosityByModel ?? {}) ? "user" : "built-in";
				lines.push(`    ${modelId.padEnd(20)} ${formatVerbosity(resolved)}  (${source})`);
			}
		}

		// Current model
		const current = ctx.model;
		if (current) {
			lines.push("");
			lines.push(`  Active model:   ${current.id}`);
			lines.push(`  Active verbosity: ${formatVerbosity(resolveVerbosity(current.id))}`);
		}

		lines.push("");
		lines.push("  Usage:");
		lines.push("    /verbosity <level>              Set global default");
		lines.push("    /verbosity <model> <level>      Set per-model");
		lines.push("    /verbosity <model>               Show verbosity for model");
		lines.push("");
		lines.push("╰──────────────────────────────────────────────────╯");

		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	if (parts.length === 1) {
		const arg = parts[0] as Verbosity;

		if (["low", "medium", "high"].includes(arg)) {
			// Set global default
			const config = getConfig();
			config.defaultVerbosity = arg;
			saveConfig(config);
			ctx.ui.notify(`Global default verbosity set to ${arg}`, "info");
			return;
		}

		// Show verbosity for a model pattern
		const pattern = arg;
		const config = getConfig();
		const matches: string[] = [];

		const allModels = new Set<string>([
			...Object.keys(BUILTIN_BY_MODEL),
			...Object.keys(config.verbosityByModel ?? {}),
		]);

		for (const mid of allModels) {
			if (modelMatchesId(mid, pattern)) {
				matches.push(`  ${mid.padEnd(20)} ${formatVerbosity(resolveVerbosity(mid))}`);
			}
		}

		if (matches.length === 0) {
			ctx.ui.notify(`No models matching "${pattern}"`, "warning");
		} else {
			ctx.ui.notify(`Models matching "${pattern}":\n${matches.join("\n")}`, "info");
		}
		return;
	}

	if (parts.length === 2) {
		const [modelPattern, level] = parts;
		if (!["low", "medium", "high"].includes(level)) {
			ctx.ui.notify(`Invalid verbosity: "${level}". Use low, medium, or high.`, "error");
			return;
		}

		const config = getConfig();
		if (!config.verbosityByModel) {
			config.verbosityByModel = {};
		}
		config.verbosityByModel[modelPattern] = level as Verbosity;
		saveConfig(config);
		ctx.ui.notify(`Verbosity for "${modelPattern}" set to ${level}`, "info");
		return;
	}

	ctx.ui.notify(`Usage: /verbosity [<level>] or /verbosity <model> [<level>]`, "info");
}

function formatVerbosity(v: Verbosity): string {
	const labels: Record<Verbosity, string> = {
		low: "low",
		medium: "medium",
		high: "high",
	};
	return labels[v];
}

// ─── Extension entry ─────────────────────────────────────────────────────

export default function verbosityControlExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		loadedConfig = null; // refresh on session start
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		// Only intercept OpenAI Codex requests
		if (model.api !== "openai-codex-responses") return;

		const verbosity = resolveVerbosity(model.id);

		const payload = event.payload as CodexPayload;

		// Skip if already set to avoid overwriting a user's explicit choice
		if (payload.text?.verbosity === verbosity) return;

		return {
			...payload,
			text: {
				...payload.text,
				verbosity,
			},
		};
	});

	pi.registerCommand("verbosity", {
		description:
			"Show or set text verbosity for OpenAI Codex models. Usage: /verbosity, /verbosity <level>, /verbosity <model> <level>",
		handler: handleVerbosityCommand,
	});
}
