/**
 * Skill resolution and caching for subagents-lite.
 * Adapted from pi-subagents to keep behavior aligned.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SkillSource =
	| "project"
	| "user"
	| "project-package"
	| "user-package"
	| "project-settings"
	| "user-settings"
	| "extension"
	| "builtin"
	| "unknown";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: SkillSource;
}

interface SkillCacheEntry {
	mtime: number;
	skill: ResolvedSkill;
}

interface CachedSkillEntry {
	name: string;
	filePath: string;
	source: SkillSource;
	description?: string;
	order: number;
}

interface SkillSearchPath {
	path: string;
	source: SkillSource;
}

const skillCache = new Map<string, SkillCacheEntry>();
const MAX_CACHE_SIZE = 50;

let loadSkillsCache: { cwd: string; skills: CachedSkillEntry[]; timestamp: number } | null = null;
const LOAD_SKILLS_CACHE_TTL_MS = 5000;

const CONFIG_DIR = ".pi";
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

const SOURCE_PRIORITY: Record<SkillSource, number> = {
	project: 700,
	"project-settings": 650,
	"project-package": 600,
	user: 300,
	"user-settings": 250,
	"user-package": 200,
	extension: 150,
	builtin: 100,
	unknown: 0,
};

function stripSkillFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return normalized;

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;

	return normalized.slice(endIndex + 4).trim();
}

function isWithinPath(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readOptionalJsonFile(filePath: string, label: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		if (code === "ENOENT") return null;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${label} '${filePath}': ${message}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function readJsonFileBestEffort(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function extractSkillPathsFromPackageRoot(packageRoot: string, source: SkillSource, bestEffort = false): SkillSearchPath[] {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const pkg = bestEffort
		? readJsonFileBestEffort(packageJsonPath)
		: readOptionalJsonFile(packageJsonPath, "package manifest");
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];
	const pi = (pkg as { pi?: unknown }).pi;
	if (!pi || typeof pi !== "object" || Array.isArray(pi)) return [];
	const skills = (pi as { skills?: unknown }).skills;
	if (!Array.isArray(skills)) return [];
	return skills
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => ({ path: path.resolve(packageRoot, entry), source }));
}

let cachedGlobalNpmRoot: string | null = null;

function getGlobalNpmRoot(): string | null {
	if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot || null;
	try {
		cachedGlobalNpmRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
		return cachedGlobalNpmRoot;
	} catch {
		cachedGlobalNpmRoot = "";
		return null;
	}
}

function collectInstalledPackageSkillPaths(cwd: string): SkillSearchPath[] {
	const dirs: SkillSearchPath[] = [
		{ path: path.join(cwd, CONFIG_DIR, "npm", "node_modules"), source: "project-package" },
		{ path: path.join(AGENT_DIR, "npm", "node_modules"), source: "user-package" },
	];

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot) {
		dirs.push({ path: globalRoot, source: "user-package" });
	}

	const results: SkillSearchPath[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir.path)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

			if (entry.name.startsWith("@")) {
				const scopeDir = path.join(dir.path, entry.name);
				let scopeEntries: fs.Dirent[];
				try {
					scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const scopeEntry of scopeEntries) {
					if (scopeEntry.name.startsWith(".")) continue;
					if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
					const pkgRoot = path.join(scopeDir, scopeEntry.name);
					results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
				}
				continue;
			}

			const pkgRoot = path.join(dir.path, entry.name);
			results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
		}
	}

	return results;
}

function collectSettingsSkillPaths(cwd: string): SkillSearchPath[] {
	const results: SkillSearchPath[] = [];
	const settingsFiles = [
		{ file: path.join(cwd, CONFIG_DIR, "settings.json"), base: path.join(cwd, CONFIG_DIR), source: "project-settings" as const },
		{ file: path.join(AGENT_DIR, "settings.json"), base: AGENT_DIR, source: "user-settings" as const },
	];

	for (const { file, base, source } of settingsFiles) {
		const settings = readOptionalJsonFile(file, "skills settings file");
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const skills = (settings as { skills?: unknown }).skills;
		if (!Array.isArray(skills)) continue;
		for (const entry of skills) {
			if (typeof entry !== "string") continue;
			let resolved = entry;
			if (resolved.startsWith("~/")) {
				resolved = path.join(os.homedir(), resolved.slice(2));
			} else if (!path.isAbsolute(resolved)) {
				resolved = path.resolve(base, resolved);
			}
			results.push({ path: resolved, source });
		}
	}

	return results;
}

function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(baseDir, normalized);
	}
	return undefined;
}

function collectSettingsPackageSkillPaths(cwd: string): SkillSearchPath[] {
	const settingsFiles = [
		{ file: path.join(cwd, CONFIG_DIR, "settings.json"), base: path.join(cwd, CONFIG_DIR), source: "project-package" as const },
		{ file: path.join(AGENT_DIR, "settings.json"), base: AGENT_DIR, source: "user-package" as const },
	];
	const results: SkillSearchPath[] = [];

	for (const { file, base, source } of settingsFiles) {
		const settings = readOptionalJsonFile(file, "skills settings file");
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const packages = (settings as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) continue;

		for (const entry of packages) {
			const packageSource = typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
					? (entry as { source: string }).source
					: undefined;
			if (!packageSource) continue;

			const packageRoot = resolveSettingsPackageRoot(packageSource, base);
			if (!packageRoot) continue;
			results.push(...extractSkillPathsFromPackageRoot(packageRoot, source));
		}
	}

	return results;
}

function buildSkillPaths(cwd: string): SkillSearchPath[] {
	const skillPaths: SkillSearchPath[] = [
		{ path: path.join(cwd, CONFIG_DIR, "skills"), source: "project" },
		{ path: path.join(cwd, ".agents", "skills"), source: "project" },
		{ path: path.join(AGENT_DIR, "skills"), source: "user" },
		{ path: path.join(os.homedir(), ".agents", "skills"), source: "user" },
		...collectInstalledPackageSkillPaths(cwd),
		...collectSettingsPackageSkillPaths(cwd),
		...extractSkillPathsFromPackageRoot(cwd, "project-package"),
		...collectSettingsSkillPaths(cwd),
	];

	const deduped = new Map<string, SkillSearchPath>();
	for (const entry of skillPaths) {
		const resolvedPath = path.resolve(entry.path);
		if (!deduped.has(resolvedPath)) {
			deduped.set(resolvedPath, { path: resolvedPath, source: entry.source });
		}
	}
	return [...deduped.values()];
}

function inferSkillSource(filePath: string, cwd: string, sourceHint?: SkillSource): SkillSource {
	if (sourceHint) return sourceHint;

	const projectConfigRoot = path.resolve(cwd, CONFIG_DIR);
	const projectSkillsRoot = path.resolve(cwd, CONFIG_DIR, "skills");
	const projectPackagesRoot = path.resolve(cwd, CONFIG_DIR, "npm", "node_modules");
	const projectAgentsRoot = path.resolve(cwd, ".agents");
	const userSkillsRoot = path.resolve(AGENT_DIR, "skills");
	const userPackagesRoot = path.resolve(AGENT_DIR, "npm", "node_modules");
	const userAgentsRoot = path.resolve(os.homedir(), ".agents");

	if (isWithinPath(filePath, projectPackagesRoot)) return "project-package";
	if (isWithinPath(filePath, projectSkillsRoot) || isWithinPath(filePath, projectAgentsRoot)) return "project";
	if (isWithinPath(filePath, projectConfigRoot)) return "project-settings";

	if (isWithinPath(filePath, userPackagesRoot)) return "user-package";
	if (isWithinPath(filePath, userSkillsRoot) || isWithinPath(filePath, userAgentsRoot)) return "user";
	if (isWithinPath(filePath, AGENT_DIR)) return "user-settings";

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot && isWithinPath(filePath, globalRoot)) return "user-package";

	return "unknown";
}

function chooseHigherPrioritySkill(existing: CachedSkillEntry | undefined, candidate: CachedSkillEntry): CachedSkillEntry {
	if (!existing) return candidate;
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
	const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 0;
	if (candidatePriority > existingPriority) return candidate;
	if (candidatePriority < existingPriority) return existing;
	return candidate.order < existing.order ? candidate : existing;
}

function collectFilesystemSkills(cwd: string, skillPaths: SkillSearchPath[]): CachedSkillEntry[] {
	const entries: CachedSkillEntry[] = [];
	const seen = new Set<string>();
	let order = 0;

	const pushEntry = (name: string, filePath: string, sourceHint?: SkillSource): void => {
		const resolvedFile = path.resolve(filePath);
		if (seen.has(resolvedFile)) return;
		if (!fs.existsSync(resolvedFile)) return;
		seen.add(resolvedFile);
		entries.push({
			name,
			filePath: resolvedFile,
			source: inferSkillSource(resolvedFile, cwd, sourceHint),
			order: order++,
		});
	};

	for (const skillPath of skillPaths) {
		if (!fs.existsSync(skillPath.path)) continue;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(skillPath.path);
		} catch {
			continue;
		}

		if (stat.isFile()) {
			const fileName = path.basename(skillPath.path);
			if (!fileName.toLowerCase().endsWith(".md")) continue;
			const skillName = fileName.toLowerCase() === "skill.md"
				? path.basename(path.dirname(skillPath.path))
				: path.basename(fileName, path.extname(fileName));
			pushEntry(skillName, skillPath.path, skillPath.source);
			continue;
		}

		if (!stat.isDirectory()) continue;

		const rootSkillFile = path.join(skillPath.path, "SKILL.md");
		if (fs.existsSync(rootSkillFile)) {
			pushEntry(path.basename(skillPath.path), rootSkillFile, skillPath.source);
		}

		let childEntries: fs.Dirent[];
		try {
			childEntries = fs.readdirSync(skillPath.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const child of childEntries) {
			if (child.name.startsWith(".")) continue;
			const childPath = path.join(skillPath.path, child.name);
			if (child.isDirectory() || child.isSymbolicLink()) {
				const nestedSkillPath = path.join(childPath, "SKILL.md");
				if (fs.existsSync(nestedSkillPath)) {
					pushEntry(child.name, nestedSkillPath, skillPath.source);
				}
				continue;
			}
			if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
				pushEntry(path.basename(child.name, path.extname(child.name)), childPath, skillPath.source);
			}
		}
	}

	return entries;
}

function getCachedSkills(cwd: string): CachedSkillEntry[] {
	const now = Date.now();
	if (loadSkillsCache && loadSkillsCache.cwd === cwd && now - loadSkillsCache.timestamp < LOAD_SKILLS_CACHE_TTL_MS) {
		return loadSkillsCache.skills;
	}

	const skillPaths = buildSkillPaths(cwd);
	const loaded = collectFilesystemSkills(cwd, skillPaths);
	const dedupedByName = new Map<string, CachedSkillEntry>();

	for (const entry of loaded) {
		const current = dedupedByName.get(entry.name);
		dedupedByName.set(entry.name, chooseHigherPrioritySkill(current, entry));
	}

	const skills = [...dedupedByName.values()].sort((a, b) => a.order - b.order);
	loadSkillsCache = { cwd, skills, timestamp: now };
	return skills;
}

export function resolveSkills(
	skillNames: string[],
	cwd: string,
): { resolved: ResolvedSkill[]; missing: string[] } {
	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];
	const skills = getCachedSkills(cwd);

	for (const name of skillNames) {
		const trimmed = name.trim();
		if (!trimmed) continue;

		const location = skills.find((s) => s.name === trimmed);
		if (!location) {
			missing.push(trimmed);
			continue;
		}

		try {
			const stat = fs.statSync(location.filePath);
			const cached = skillCache.get(location.filePath);
			if (cached && cached.mtime === stat.mtimeMs) {
				resolved.push(cached.skill);
				continue;
			}

			const raw = fs.readFileSync(location.filePath, "utf-8");
			const skill: ResolvedSkill = {
				name: trimmed,
				path: location.filePath,
				content: stripSkillFrontmatter(raw),
				source: location.source,
			};
			skillCache.set(location.filePath, { mtime: stat.mtimeMs, skill });
			if (skillCache.size > MAX_CACHE_SIZE) {
				const firstKey = skillCache.keys().next().value;
				if (firstKey) skillCache.delete(firstKey);
			}
			resolved.push(skill);
		} catch {
			missing.push(trimmed);
		}
	}

	return { resolved, missing };
}

export function resolveSkillsWithFallback(
	skillNames: string[],
	primaryCwd: string,
	fallbackCwd?: string,
): { resolved: ResolvedSkill[]; missing: string[] } {
	const primary = resolveSkills(skillNames, primaryCwd);
	if (!fallbackCwd || primary.missing.length === 0) return primary;
	if (path.resolve(primaryCwd) === path.resolve(fallbackCwd)) return primary;

	const fallback = resolveSkills(primary.missing, fallbackCwd);
	return {
		resolved: [...primary.resolved, ...fallback.resolved],
		missing: fallback.missing,
	};
}

export function buildSkillInjection(skills: ResolvedSkill[]): string {
	if (skills.length === 0) return "";
	return skills
		.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
		.join("\n\n");
}

export function clearSkillCache(): void {
	skillCache.clear();
	loadSkillsCache = null;
}
