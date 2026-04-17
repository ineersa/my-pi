import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, "packages");

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function fail(errors, message) {
	errors.push(message);
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function toPackagePath(packageRoot, absolutePath) {
	return relative(packageRoot, absolutePath).replace(/\\/g, "/");
}

function validateDocsRef(packageRoot, pkgName, entityId, key, docPath, errors) {
	if (typeof docPath !== "string" || docPath.trim().length === 0) {
		fail(errors, `[${pkgName}] ${entityId}: docs.${key} must be a non-empty string`);
		return;
	}
	const fullPath = join(packageRoot, docPath);
	if (!existsSync(fullPath)) {
		fail(errors, `[${pkgName}] ${entityId}: missing file '${docPath}'`);
	}
}

function validateEntryPath(packageRoot, pkgName, entityId, entry, errors) {
	if (typeof entry !== "string" || entry.trim().length === 0) {
		return;
	}
	if (!entry.startsWith("./")) {
		return;
	}
	const fullPath = join(packageRoot, entry.slice(2));
	if (!existsSync(fullPath)) {
		fail(errors, `[${pkgName}] ${entityId}: entry path not found '${entry}'`);
	}
}

function validatePackage(packageDirName, errors) {
	const packageRoot = join(PACKAGES_DIR, packageDirName);
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		return;
	}

	const pkg = readJson(packageJsonPath);
	const pkgName = pkg.name || packageDirName;
	const indexPath = join(packageRoot, "docs", "ai-index.json");

	if (!existsSync(indexPath)) {
		fail(errors, `[${pkgName}] missing docs/ai-index.json`);
		return;
	}

	if (!Array.isArray(pkg.files) || !pkg.files.includes("docs")) {
		fail(errors, `[${pkgName}] package.json files[] must include 'docs'`);
	}

	const index = readJson(indexPath);
	if (index.spec !== "my-pi.ai-docs/v1") {
		fail(errors, `[${pkgName}] ai-index spec must be 'my-pi.ai-docs/v1'`);
	}
	if (index.package !== pkg.name) {
		fail(errors, `[${pkgName}] ai-index package '${index.package}' does not match package.json name '${pkg.name}'`);
	}
	if (index.version !== pkg.version) {
		fail(errors, `[${pkgName}] ai-index version '${index.version}' does not match package.json version '${pkg.version}'`);
	}
	if (!Array.isArray(index.entities)) {
		fail(errors, `[${pkgName}] ai-index must use an 'entities' array`);
		return;
	}

	const entryToEntity = new Map();

	for (const entity of index.entities) {
		if (!entity || typeof entity !== "object") {
			fail(errors, `[${pkgName}] ai-index entity must be an object`);
			continue;
		}

		const entityId = entity.id;
		if (typeof entityId !== "string" || entityId.trim().length === 0) {
			fail(errors, `[${pkgName}] entity missing non-empty 'id'`);
			continue;
		}
		if (typeof entity.kind !== "string" || entity.kind.trim().length === 0) {
			fail(errors, `[${pkgName}] ${entityId}: missing non-empty 'kind'`);
		}
		if (typeof entity.name !== "string" || entity.name.trim().length === 0) {
			fail(errors, `[${pkgName}] ${entityId}: missing non-empty 'name'`);
		}

		if (!entity.docs || typeof entity.docs !== "object") {
			fail(errors, `[${pkgName}] ${entityId}: missing docs object`);
		} else {
			validateDocsRef(packageRoot, pkgName, entityId, "settings", entity.docs.settings, errors);
			validateDocsRef(packageRoot, pkgName, entityId, "usage", entity.docs.usage, errors);
			validateDocsRef(packageRoot, pkgName, entityId, "maintenance", entity.docs.maintenance, errors);
		}

		validateEntryPath(packageRoot, pkgName, entityId, entity.entry, errors);
		if (typeof entity.entry === "string" && entity.entry.startsWith("./")) {
			entryToEntity.set(entity.entry, entity);
		}
	}

	const piExtensions = pkg?.pi?.extensions;
	if (Array.isArray(piExtensions) && piExtensions.length > 0) {
		const extensionEntities = index.entities.filter((entity) => entity?.kind === "extension");
		const indexedEntries = new Set(extensionEntities.map((entity) => entity.entry));

		for (const extensionEntry of piExtensions) {
			if (!indexedEntries.has(extensionEntry)) {
				fail(errors, `[${pkgName}] missing extension entity for '${extensionEntry}'`);
			}
		}

		for (const entry of indexedEntries) {
			if (!piExtensions.includes(entry)) {
				fail(errors, `[${pkgName}] extension entity entry '${entry}' not present in package.json pi.extensions`);
			}
		}
	}

	if (pkgName === "@ineersa/my-pi-themes") {
		const themesDir = join(packageRoot, "themes");
		if (!isDirectory(themesDir)) {
			fail(errors, `[${pkgName}] missing themes directory`);
			return;
		}
		const themeFiles = readdirSync(themesDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => `./themes/${name}`)
			.sort();
		const themeEntries = index.entities
			.filter((entity) => entity?.kind === "theme")
			.map((entity) => entity.entry)
			.sort();

		for (const file of themeFiles) {
			if (!themeEntries.includes(file)) {
				fail(errors, `[${pkgName}] missing theme entity for '${file}'`);
			}
		}
		for (const entry of themeEntries) {
			if (!themeFiles.includes(entry)) {
				fail(errors, `[${pkgName}] theme entity entry '${entry}' has no matching theme file`);
			}
		}
	}

	const docsFiles = [];
	const docsRoot = join(packageRoot, "docs");
	const stack = [docsRoot];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const item of readdirSync(current)) {
			const absolute = join(current, item);
			const stats = statSync(absolute);
			if (stats.isDirectory()) {
				stack.push(absolute);
			} else {
				docsFiles.push(toPackagePath(packageRoot, absolute));
			}
		}
	}
	if (docsFiles.length === 0) {
		fail(errors, `[${pkgName}] docs directory is empty`);
	}
}

const errors = [];
for (const dir of readdirSync(PACKAGES_DIR)) {
	validatePackage(dir, errors);
}

if (errors.length > 0) {
	console.error("AI docs validation failed:\n");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

console.log("AI docs validation passed.");
