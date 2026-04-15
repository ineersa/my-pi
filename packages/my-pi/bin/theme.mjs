#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

function printHelp() {
  console.log(
    `
my-pi-theme — list and set themes

Usage:
  node packages/my-pi/bin/theme.mjs list
  node packages/my-pi/bin/theme.mjs set <theme-name> [--global|--project]
  node packages/my-pi/bin/theme.mjs set <theme-name> --settings <path>

Options:
  -g, --global             Write to ~/.pi/agent/settings.json
  -p, --project            Write to ./.pi/settings.json (default)
      --settings <path>    Custom settings file path
      --themes-dir <path>  Custom theme directory (default: packages/themes/themes)
  -h, --help               Show this help
`.trim(),
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    command: args[0] ?? "help",
    themeName: null,
    scope: "project",
    settingsPath: null,
    themesDir: resolve(repoRoot, "packages/themes/themes"),
  };

  if (parsed.command === "set") {
    parsed.themeName = args[1] ?? null;
  }

  for (let i = parsed.command === "set" ? 2 : 1; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--global" || arg === "-g") {
      parsed.scope = "global";
      continue;
    }

    if (arg === "--project" || arg === "-p") {
      parsed.scope = "project";
      continue;
    }

    if (arg === "--settings") {
      const next = args[i + 1];
      i += 1;
      if (!next) {
        throw new Error("--settings requires a value");
      }
      parsed.settingsPath = next;
      continue;
    }

    if (arg === "--themes-dir") {
      const next = args[i + 1];
      i += 1;
      if (!next) {
        throw new Error("--themes-dir requires a value");
      }
      parsed.themesDir = isAbsolute(next) ? next : resolve(process.cwd(), next);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.command = "help";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function loadThemes(themesDir) {
  if (!existsSync(themesDir)) {
    throw new Error(`Theme directory not found: ${themesDir}`);
  }

  const files = readdirSync(themesDir)
    .filter((name) => extname(name) === ".json")
    .sort();

  return files.map((fileName) => {
    const filePath = resolve(themesDir, fileName);
    const raw = readFileSync(filePath, "utf8");
    const theme = JSON.parse(raw);

    return {
      fileName,
      name: typeof theme.name === "string" ? theme.name : fileName.replace(/\.json$/, ""),
    };
  });
}

function resolveSettingsPath(opts) {
  if (opts.settingsPath) {
    return isAbsolute(opts.settingsPath) ? opts.settingsPath : resolve(process.cwd(), opts.settingsPath);
  }

  if (opts.scope === "global") {
    return join(os.homedir(), ".pi/agent/settings.json");
  }

  return resolve(process.cwd(), ".pi/settings.json");
}

function loadSettings(path) {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse settings file: ${path}\n${error.message}`);
  }
}

function saveSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

try {
  const opts = parseArgs(process.argv);

  if (opts.command === "help" || opts.command === "-h" || opts.command === "--help") {
    printHelp();
    process.exit(0);
  }

  const themes = loadThemes(opts.themesDir);

  if (opts.command === "list") {
    console.log("Available themes:\n");
    for (const theme of themes) {
      console.log(`  • ${theme.name}`);
    }
    process.exit(0);
  }

  if (opts.command === "set") {
    if (!opts.themeName) {
      throw new Error("Missing theme name. Usage: set <theme-name>");
    }

    const match = themes.find((theme) => theme.name === opts.themeName);
    if (!match) {
      const names = themes.map((theme) => theme.name).join(", ");
      throw new Error(`Unknown theme: ${opts.themeName}\nAvailable themes: ${names}`);
    }

    const settingsPath = resolveSettingsPath(opts);
    const settings = loadSettings(settingsPath);
    settings.theme = match.name;
    saveSettings(settingsPath, settings);

    console.log(`✓ Set theme to '${match.name}' in ${settingsPath}`);
    console.log("  Restart pi (or /reload) to apply it.");
    process.exit(0);
  }

  throw new Error(`Unknown command: ${opts.command}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
