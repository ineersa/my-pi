#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { INSTALLER_PACKAGES } from "./package-list.mjs";

const IS_WINDOWS = process.platform === "win32";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

// ── Minimal frontmatter parser ────────────────────────────────────────

function parseFrontmatter(content) {
	if (!content.startsWith("---")) return { frontmatter: {}, body: content };
	const end = content.indexOf("---", 3);
	if (end === -1) return { frontmatter: {}, body: content };
	const yaml = content.slice(3, end);
	const body = content.slice(end + 3).trim();
	const frontmatter = {};
	for (const line of yaml.split("\n")) {
		const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (match) {
			const [, key, value] = match;
			frontmatter[key] = value.trim();
		}
	}
	return { frontmatter, body };
}

function serializeFrontmatter(frontmatter, body) {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined && value !== null) {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---");
	lines.push("");
	if (body) lines.push(body);
	return lines.join("\n") + "\n";
}

// ── Interactive prompt helpers ─────────────────────────────────────────

function prompt(rl, question) {
	return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function promptYesNo(rl, question, defaultYes = true) {
	const hint = defaultYes ? "[Y/n]" : "[y/N]";
	return prompt(rl, `${question} ${hint} `).then((answer) => {
		if (!answer) return defaultYes;
		return answer.toLowerCase().startsWith("y");
	});
}

async function promptChoice(rl, question, options, defaultIndex = 0) {
	console.log(`\n  ${question}`);
	options.forEach((opt, i) => {
		const marker = i === defaultIndex ? " →" : "  ";
		console.log(`${marker} ${i + 1}. ${opt.label}`);
	});
	const answer = await prompt(rl, `  Choose [1-${options.length}] (default ${defaultIndex + 1}): `);
	if (!answer) return options[defaultIndex];
	const idx = parseInt(answer, 10) - 1;
	if (idx >= 0 && idx < options.length) return options[idx];
	console.log(`  Invalid choice, using default.`);
	return options[defaultIndex];
}

// ── Arg parser ─────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = argv.slice(2);
	const result = { version: null, local: false, remove: false, help: false, source: "npm", yes: false };

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];

		if (arg === "--version" || arg === "-v") {
			result.version = args[i + 1] ?? null;
			i += 1;
			if (!result.version) {
				console.error("Error: --version requires a value");
				process.exit(1);
			}
			continue;
		}
		if (arg === "--local" || arg === "-l") { result.local = true; continue; }
		if (arg === "--remove" || arg === "-r") { result.remove = true; continue; }
		if (arg === "--yes" || arg === "-y") { result.yes = true; continue; }
		if (arg === "--source") {
			const next = args[++i];
			if (next !== "npm" && next !== "local") {
				console.error("Error: --source must be one of: npm, local");
				process.exit(1);
			}
			result.source = next;
			continue;
		}
		if (arg === "--help" || arg === "-h") { result.help = true; continue; }

		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}

	return result;
}

function printHelp() {
	console.log(
		`
my-pi — install your pi package set

Usage:
  npx @ineersa/my-pi                     Install from npm (interactive)
  npx @ineersa/my-pi --yes               Install everything with defaults
                                          (and apply bundled pi-settings if present)
  npx @ineersa/my-pi --local             Install project-local (.pi/settings.json)
  npx @ineersa/my-pi --remove            Remove all listed packages
  npx @ineersa/my-pi --version 0.1.0     Pin npm package versions
  npx @ineersa/my-pi --source local      Install from local workspace paths

Options:
  -v, --version <ver>   Pin package version (npm source only)
  -l, --local           Use project settings (.pi/settings.json)
  -r, --remove          Remove package specs from pi settings
  -y, --yes             Accept all defaults (non-interactive)
      --source <mode>   npm | local (default: npm)
  -h, --help            Show this help

Packages:
${INSTALLER_PACKAGES.map((pkg) => `  • ${pkg.name} (${pkg.npmName})`).join("\n")}
`.trim(),
	);
}

// ── Pi helpers ─────────────────────────────────────────────────────────

function findPi() {
	const candidates = IS_WINDOWS ? ["pi.cmd", "pi"] : ["pi"];
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore", shell: IS_WINDOWS });
			return candidate;
		} catch { /* next */ }
	}
	console.error("Error: 'pi' command not found. Install pi-coding-agent first:");
	console.error("  npm install -g @mariozechner/pi-coding-agent");
	process.exit(1);
}

function toInstallSource(pkg, opts) {
	if (opts.source === "local") return resolve(repoRoot, pkg.localPath);
	const suffix = opts.version ? `@${opts.version}` : "";
	return `npm:${pkg.npmName}${suffix}`;
}

function toRemoveSource(pkg, opts) {
	if (opts.source === "local") return resolve(repoRoot, pkg.localPath);
	return `npm:${pkg.npmName}`;
}

function run(pi, command, args, { label }) {
	process.stdout.write(`  ${label} ... `);
	try {
		execFileSync(pi, [command, ...args], {
			stdio: "pipe",
			timeout: 60_000,
			shell: IS_WINDOWS,
		});
		console.log("✓");
		return true;
	} catch (error) {
		const stderr = error.stderr?.toString() ?? "";
		const stdout = error.stdout?.toString() ?? "";
		const message = `${stdout}\n${stderr}`.toLowerCase();

		if (command === "install" && (message.includes("already installed") || message.includes("already exists"))) {
			console.log("✓ (already installed)");
			return true;
		}
		if (command === "remove" && (message.includes("not installed") || message.includes("not found") || message.includes("does not exist"))) {
			console.log("✓ (not installed)");
			return true;
		}

		console.log("✗");
		const firstLine = stderr.trim().split("\n").find(Boolean) ?? stdout.trim().split("\n").find(Boolean);
		if (firstLine) console.error(`    ${firstLine}`);
		return false;
	}
}

const PI_SETTINGS_AGENT_FILES = [
	"compaction-policy.json",
	"mcp.json",
	"models.json",
	"safe-guard.json",
	"settings.json",
];

const PI_SETTINGS_AGENT_DIRS = [
	"prompts",
];

function copyDirFiltered(src, dest) {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		if (entry.name === "auth.json") continue;
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirFiltered(srcPath, destPath);
		} else if (entry.isFile()) {
			copyFileSync(srcPath, destPath);
		}
	}
}

function findBundledPiSettingsDir() {
	const candidates = [
		join(repoRoot, "pi-settings"),
		join(scriptDir, "..", "pi-settings"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function installBundledGlobalPiSettings() {
	const sourceDir = findBundledPiSettingsDir();
	const globalPiDir = join(homedir(), ".pi");
	process.stdout.write("  Installing global pi settings snapshot ... ");
	if (!sourceDir) {
		console.log("skipped (no bundled pi-settings directory)");
		return;
	}
	try {
		const agentSource = join(sourceDir, "agent");
		const agentTarget = join(globalPiDir, "agent");
		let copied = 0;
		for (const file of PI_SETTINGS_AGENT_FILES) {
			const src = join(agentSource, file);
			if (!existsSync(src)) continue;
			mkdirSync(agentTarget, { recursive: true });
			copyFileSync(src, join(agentTarget, file));
			copied++;
		}
		for (const dir of PI_SETTINGS_AGENT_DIRS) {
			const src = join(agentSource, dir);
			if (!existsSync(src)) continue;
			mkdirSync(agentTarget, { recursive: true });
			copyDirFiltered(src, join(agentTarget, dir));
			copied++;
		}
		console.log(`✓ (${copied} item(s) from ${relative(process.cwd(), sourceDir) || sourceDir}/agent -> ${globalPiDir}/agent)`);
	} catch (err) {
		console.log(`✗ (${err.message})`);
	}
}

// ── Agent install logic ────────────────────────────────────────────────

const BUILTIN_MODELS = [
	{ label: "default (inherit from parent)", value: "" },
	{ label: "anthropic/claude-sonnet-4", value: "anthropic/claude-sonnet-4" },
	{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5" },
	{ label: "google/gemini-2.5-pro", value: "google/gemini-2.5-pro" },
	{ label: "openai/gpt-4.1", value: "openai/gpt-4.1" },
	{ label: "ollama/llama3", value: "ollama/llama3" },
	{ label: "custom", value: "__custom__" },
];

function getSourceAgentsDir(opts) {
	return opts.source === "local"
		? join(repoRoot, ".agents")
		: join(scriptDir, "..", ".agents");
}

function getAgentNameFromFile(file) {
	return file.replace(/\.md$/, "");
}

/**
 * Install a single agent file. Returns true if installed/skipped, false on error.
 */
async function installAgent(rl, sourceDir, targetDir, file, nonInteractive) {
	const sourcePath = join(sourceDir, file);
	const targetPath = join(targetDir, file);
	const agentName = getAgentNameFromFile(file);
	const sourceContent = readFileSync(sourcePath, "utf-8");
	const { frontmatter: srcFm, body: srcBody } = parseFrontmatter(sourceContent);

	// Target doesn't exist — fresh install
	if (!existsSync(targetPath)) {
		let content = sourceContent;
		if (!nonInteractive) {
			console.log(`\n  📄 Agent: ${agentName}`);
			console.log(`     ${srcFm.description || "(no description)"}`);
			const install = await promptYesNo(rl, `  Install this agent?`, true);
			if (!install) {
				console.log("     Skipped.");
				return true;
			}
			content = await customizeAgent(rl, srcFm, srcBody);
		}
		writeFileSync(targetPath, content, "utf-8");
		console.log(`  ✓ ${agentName} installed`);
		return true;
	}

	// Target exists — check if update needed
	const targetContent = readFileSync(targetPath, "utf-8");
	const { frontmatter: tgtFm, body: tgtBody } = parseFrontmatter(targetContent);

	if (targetContent === sourceContent) {
		console.log(`  ✓ ${agentName} (up to date)`);
		return true;
	}

	// Target was customized by user — show diff and ask
	if (!nonInteractive) {
		console.log(`\n  📄 Agent: ${agentName}`);
		console.log(`     ${srcFm.description || "(no description)"}`);

		if (tgtFm.model !== srcFm.model || tgtFm.tools !== srcFm.tools) {
			console.log(`     Your config:  model=${tgtFm.model || "(default)"} tools=${tgtFm.tools || "(default)"}`);
			console.log(`     New defaults: model=${srcFm.model || "(default)"} tools=${srcFm.tools || "(default)"}`);
		}

		if (tgtBody !== srcBody) {
			console.log(`     ⚠ Instructions have changed.`);
		}

		const action = await promptChoice(rl, `What to do with ${agentName}?`, [
			{ label: "Keep yours (no change)", value: "keep" },
			{ label: "Update to new defaults", value: "update" },
			{ label: "Update but keep your model/tools", value: "merge" },
			{ label: "Show diff", value: "diff" },
		], 0);

		if (action.value === "diff") {
			showAgentDiff(targetContent, sourceContent);
			const retry = await promptChoice(rl, `Now what?`, [
				{ label: "Keep yours", value: "keep" },
				{ label: "Update to new defaults", value: "update" },
				{ label: "Update but keep your model/tools", value: "merge" },
			], 0);
			return handleAgentAction(retry.value, targetPath, srcFm, srcBody, tgtFm, tgtBody);
		}

		return handleAgentAction(action.value, targetPath, srcFm, srcBody, tgtFm, tgtBody);
	}

	// Non-interactive: update body, preserve user's frontmatter customizations
	const merged = serializeFrontmatter(tgtFm, srcBody);
	writeFileSync(targetPath, merged, "utf-8");
	console.log(`  ✓ ${agentName} updated (kept your settings)`);
	return true;
}

function handleAgentAction(action, targetPath, srcFm, srcBody, tgtFm, tgtBody) {
	switch (action) {
		case "keep":
			console.log("     Kept your version.");
			return true;
		case "update":
			writeFileSync(targetPath, serializeFrontmatter(srcFm, srcBody), "utf-8");
			console.log("     ✓ Updated to new defaults.");
			return true;
		case "merge":
			writeFileSync(targetPath, serializeFrontmatter(tgtFm, srcBody), "utf-8");
			console.log("     ✓ Updated instructions, kept your model/tools.");
			return true;
	}
	return true;
}

async function customizeAgent(rl, srcFm, srcBody) {
	const fm = { ...srcFm };

	// Model customization
	const currentModel = fm.model || "";
	const hasModel = currentModel.length > 0;
	const defaultModelIdx = hasModel
		? BUILTIN_MODELS.findIndex((m) => m.value === currentModel)
		: 0;

	if (hasModel) {
		console.log(`     Current model: ${currentModel}`);
		const change = await promptYesNo(rl, `  Change model?`, false);
		if (change) {
			const choice = await promptChoice(rl, "Select model:", BUILTIN_MODELS, Math.max(0, defaultModelIdx));
			if (choice.value === "__custom__") {
				const custom = await prompt(rl, "  Enter model name: ");
				if (custom) fm.model = custom;
			} else {
				fm.model = choice.value;
			}
		}
	} else {
		const setModel = await promptYesNo(rl, `  Set a custom model?`, false);
		if (setModel) {
			const choice = await promptChoice(rl, "Select model:", BUILTIN_MODELS, 0);
			if (choice.value === "__custom__") {
				const custom = await prompt(rl, "  Enter model name: ");
				if (custom) fm.model = custom;
			} else if (choice.value) {
				fm.model = choice.value;
			}
		}
	}

	// Thinking customization
	if (fm.thinking) {
		console.log(`     Current thinking: ${fm.thinking}`);
		const changeThinking = await promptYesNo(rl, `  Change thinking level?`, false);
		if (changeThinking) {
			const choice = await promptChoice(rl, "Select thinking:", [
				{ label: "off", value: "off" },
				{ label: "low", value: "low" },
				{ label: "medium", value: "medium" },
				{ label: "high", value: "high" },
				{ label: "xhigh", value: "xhigh" },
			], ["off", "low", "medium", "high", "xhigh"].indexOf(fm.thinking));
			fm.thinking = choice.value;
		}
	}

	return serializeFrontmatter(fm, srcBody);
}

function showAgentDiff(oldContent, newContent) {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLen = Math.max(oldLines.length, newLines.length);

	console.log("\n     ── diff (yours → new) ──");
	for (let i = 0; i < maxLen; i++) {
		const o = oldLines[i];
		const n = newLines[i];
		if (o === n) continue;
		if (o === undefined) console.log(`     + ${n}`);
		else if (n === undefined) console.log(`     - ${o}`);
		else {
			console.log(`     - ${o}`);
			console.log(`     + ${n}`);
		}
	}
	console.log("     ── end diff ──\n");
}

function parseSkillDescription(skillDir) {
	const skillMd = join(skillDir, "SKILL.md");
	if (!existsSync(skillMd)) return "";
	const { frontmatter } = parseFrontmatter(readFileSync(skillMd, "utf-8"));
	return frontmatter.description || "";
}

function copyDirRecursive(src, dest) {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else if (entry.isFile()) {
			copyFileSync(srcPath, destPath);
		}
	}
}

function rmDirRecursive(dir) {
	if (!existsSync(dir)) return;
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink()) {
		unlinkSync(dir);
		return;
	}
	rmSync(dir, { recursive: true, force: true });
}

async function installSkill(rl, sourceDir, targetDir, dirName, nonInteractive) {
	const sourceSkill = join(sourceDir, dirName);
	const targetSkill = join(targetDir, dirName);
	const desc = parseSkillDescription(sourceSkill);

	if (!existsSync(targetSkill)) {
		// Fresh install
		if (!nonInteractive) {
			console.log(`\n  🔧 Skill: ${dirName}`);
			console.log(`     ${desc}`);
			const install = await promptYesNo(rl, `  Install this skill?`, true);
			if (!install) {
				console.log("     Skipped.");
				return;
			}
		}
		copyDirRecursive(sourceSkill, targetSkill);
		console.log(`  ✓ ${dirName} installed`);
		return;
	}

	// Target exists — check what it is
	const stat = lstatSync(targetSkill);

	if (stat.isSymbolicLink()) {
		// Old symlink from previous installer — replace with copy
		unlinkSync(targetSkill);
		copyDirRecursive(sourceSkill, targetSkill);
		console.log(`  ✓ ${dirName} (replaced old symlink with copy)`);
		return;
	}

	// Real directory — check if user has customized it
	// Compare by checking if SKILL.md matches
	const srcSkillMd = join(sourceSkill, "SKILL.md");
	const tgtSkillMd = join(targetSkill, "SKILL.md");

	let isUserModified = false;
	if (existsSync(srcSkillMd) && existsSync(tgtSkillMd)) {
		const srcContent = readFileSync(srcSkillMd, "utf-8");
		const tgtContent = readFileSync(tgtSkillMd, "utf-8");
		if (srcContent !== tgtContent) isUserModified = true;
	}

	// Also check if source has files the target doesn't
	const srcFiles = new Set(readdirSync(sourceSkill));
	const tgtFiles = new Set(readdirSync(targetSkill));
	if (!isUserModified) {
		for (const f of srcFiles) {
			if (!tgtFiles.has(f)) { isUserModified = false; break; }
		}
		// Check for new reference files etc.
		for (const f of srcFiles) {
			if (!tgtFiles.has(f)) {
				isUserModified = true; // source has new files → needs update
				break;
			}
		}
	}

	if (!isUserModified) {
		console.log(`  ✓ ${dirName} (up to date)`);
		return;
	}

	// Needs update
	if (nonInteractive) {
		// Overwrite with source version
		rmDirRecursive(targetSkill);
		copyDirRecursive(sourceSkill, targetSkill);
		console.log(`  ✓ ${dirName} updated`);
		return;
	}

	// Interactive: ask
	console.log(`\n  🔧 Skill: ${dirName}`);
	console.log(`     ${desc}`);
	console.log("     ⚠ Local copy differs from source.");
	const action = await promptChoice(rl, `What to do with ${dirName}?`, [
		{ label: "Keep yours", value: "keep" },
		{ label: "Replace with new version", value: "replace" },
	], 0);

	if (action.value === "replace") {
		rmDirRecursive(targetSkill);
		copyDirRecursive(sourceSkill, targetSkill);
		console.log("     ✓ Replaced with new version.");
	} else {
		console.log("     Kept your version.");
	}
}

// ── Main ───────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

if (opts.help) {
	printHelp();
	process.exit(0);
}

if (opts.source === "local" && opts.version) {
	console.warn("Warning: --version is ignored when --source local is used.");
}

const pi = findPi();
const localFlag = opts.local ? ["-l"] : [];

// ── Remove mode ────────────────────────────────────────────────────────

if (opts.remove) {
	console.log(`\n🧹 Removing my-pi package set (source=${opts.source})...\n`);
	let failures = 0;

	for (const pkg of INSTALLER_PACKAGES) {
		const spec = toRemoveSource(pkg, opts);
		const ok = run(pi, "remove", [spec, ...localFlag], { label: pkg.name });
		if (!ok) failures += 1;
	}

	console.log(failures === 0 ? "\n✅ Done." : `\n⚠️  ${failures} package(s) failed to remove.`);
	process.exit(failures > 0 ? 1 : 0);
}

// ── Install mode ───────────────────────────────────────────────────────

async function main() {
	console.log(`\n📦 Installing my-pi package set (source=${opts.source}, scope=${opts.local ? "project" : "global"})...\n`);

	const isTerminal = process.stdin.isTTY;
	const nonInteractive = opts.yes || !isTerminal;
	if (!isTerminal && !opts.yes) {
		console.log("  (stdin not a terminal, using non-interactive mode. Use --yes to suppress this message)");
	}

	let installPackages = true;
	let installAgentsAndSkills = !opts.local;
	let installGlobalPiSettings = false;

	if (!opts.local && !nonInteractive) {
		const hasBundledPiSettings = Boolean(findBundledPiSettingsDir());
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		installPackages = await promptYesNo(rl, "Install extensions/packages?", true);
		installAgentsAndSkills = await promptYesNo(rl, "Install agents + skills?", true);
		if (hasBundledPiSettings) {
			installGlobalPiSettings = await promptYesNo(
				rl,
				"Install global pi settings from bundled pi-settings (overwrite matching files, keep auth.json)?",
				true,
			);
		} else {
			console.log("  (No bundled pi-settings directory found; skipping global settings step)");
		}
		rl.close();
	} else if (!opts.local && nonInteractive) {
		installGlobalPiSettings = Boolean(findBundledPiSettingsDir());
	}

	let failures = 0;

	// ── 1. Restore bundled settings FIRST (before pi install modifies settings.json) ──

	if (!opts.local && installGlobalPiSettings) {
		installBundledGlobalPiSettings();
	} else if (!opts.local) {
		console.log("  Skipped global pi settings installation.");
	}

	// ── 2. Ensure workspace deps when using --source local ──────────────────────

	if (opts.source === "local" && existsSync(join(repoRoot, "package.json"))) {
		if (!existsSync(join(repoRoot, "node_modules"))) {
			process.stdout.write("  Installing workspace dependencies (npm install) ... ");
			try {
				execFileSync("npm", ["install"], { cwd: repoRoot, stdio: "pipe", timeout: 120_000, shell: IS_WINDOWS });
				console.log("✓");
			} catch (err) {
				console.log(`✗ (${err.stderr?.toString()?.trim() || err.message})`);
				console.log("  ⚠ Extensions with npm dependencies may not load.");
			}
		} else {
			console.log("  ✓ Workspace node_modules present");
		}
	}

	// ── 3. Install packages (appends to the now-restored settings.json) ──────────

	if (installPackages) {
		for (const pkg of INSTALLER_PACKAGES) {
			const spec = toInstallSource(pkg, opts);
			const ok = run(pi, "install", [spec, ...localFlag], { label: pkg.name });
			if (!ok) failures += 1;
		}

		if (failures > 0) {
			console.log(`\n⚠️  ${failures} package(s) failed to install.`);
			process.exit(1);
		}
	} else {
		console.log("  Skipped package installation.");
	}

	if (!opts.local && installPackages) {
		const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
		const DEFAULT_THEME = "cyberpunk";

		process.stdout.write("  Setting default theme ... ");
		try {
			let settings = {};
			if (existsSync(globalSettingsPath)) {
				settings = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
			}
			if (!settings.theme) {
				settings.theme = DEFAULT_THEME;
				mkdirSync(dirname(globalSettingsPath), { recursive: true });
				writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
				console.log(`✓ (set to ${DEFAULT_THEME})`);
			} else {
				console.log(`✓ (already set to ${settings.theme})`);
			}
		} catch (err) {
			console.log(`✗ (${err.message})`);
		}

		const globalPolicyPath = join(homedir(), ".pi", "agent", "safe-guard.json");
		const defaultPolicy = {
			allowCommandPatterns: [],
			allowWriteOutsideCwd: [],
			allowDestructiveInPaths: [],
			protectedReadPatterns: [],
			dangerousCommandPatterns: [],
		};

		process.stdout.write("  Deploying safe-guard policy ... ");
		try {
			if (!existsSync(globalPolicyPath)) {
				mkdirSync(dirname(globalPolicyPath), { recursive: true });
				writeFileSync(globalPolicyPath, JSON.stringify(defaultPolicy, null, 2) + "\n", "utf-8");
				console.log("✓");
			} else {
				console.log("✓ (already exists)");
			}
		} catch (err) {
			console.log(`✗ (${err.message})`);
		}
	}

	if (!opts.local && installAgentsAndSkills) {
		const sourceAgentsDir = getSourceAgentsDir(opts);
		const homeAgentsDir = join(homedir(), ".agents");
		const homeSkillsDir = join(homeAgentsDir, "skills");

		if (existsSync(sourceAgentsDir)) {
			const agentFiles = readdirSync(sourceAgentsDir).filter((f) => f.endsWith(".md"));
			const skillsSourceDir = join(sourceAgentsDir, "skills");
			const hasSkills = existsSync(skillsSourceDir);
			const skillDirs = hasSkills
				? readdirSync(skillsSourceDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
				: [];

			console.log(`\n📋 Agents (${agentFiles.length} available)${hasSkills ? `, ${skillDirs.length} skills` : ""}`);

			if (nonInteractive) {
				mkdirSync(homeAgentsDir, { recursive: true });
				for (const file of agentFiles) {
					const sourcePath = join(sourceAgentsDir, file);
					const targetPath = join(homeAgentsDir, file);

					if (!existsSync(targetPath)) {
						copyDirRecursive(sourcePath, targetPath);
						console.log(`  ✓ ${getAgentNameFromFile(file)} installed`);
					} else {
						const srcContent = readFileSync(sourcePath, "utf-8");
						const tgtContent = readFileSync(targetPath, "utf-8");
						if (tgtContent === srcContent) {
							console.log(`  ✓ ${getAgentNameFromFile(file)} (up to date)`);
						} else {
							const { frontmatter: tgtFm } = parseFrontmatter(tgtContent);
							const { body: srcBody } = parseFrontmatter(srcContent);
							writeFileSync(targetPath, serializeFrontmatter(tgtFm, srcBody), "utf-8");
							console.log(`  ✓ ${getAgentNameFromFile(file)} updated (kept your settings)`);
						}
					}
				}
			} else {
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				mkdirSync(homeAgentsDir, { recursive: true });
				for (const file of agentFiles) {
					await installAgent(rl, sourceAgentsDir, homeAgentsDir, file, false);
				}
				rl.close();
			}

			if (skillDirs.length > 0) {
				console.log("\n📋 Skills");
				mkdirSync(homeSkillsDir, { recursive: true });
				if (nonInteractive) {
					for (const dir of skillDirs) {
						await installSkill(null, skillsSourceDir, homeSkillsDir, dir, true);
					}
				} else {
					const rl = createInterface({ input: process.stdin, output: process.stdout });
					for (const dir of skillDirs) {
						await installSkill(rl, skillsSourceDir, homeSkillsDir, dir, false);
					}
					rl.close();
				}
			}
		}
	} else if (!opts.local) {
		console.log("  Skipped agents/skills installation.");
	}

	console.log("\n✅ All done. Restart pi (or /reload) to load updates.");
	process.exit(0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
