/**
 * Target-resolution layer for JetBrains IDE tools.
 *
 * Accepts either a location target (file + line + column) or a symbol target,
 * and resolves to a canonical { file, line, column } target suitable for
 * semantic wrapper tools (definition, references, rename, hierarchy, etc.).
 *
 * Resolution strategy:
 *  1. Location mode: validate path, return directly.
 *  2. Symbol mode: parse shape lightly, route to language-aware backend.
 *
 * Design principle: prefer IDE tools for actual resolution; do not build
 * custom language parsers.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { JetBrainsService, ToolCatalog } from "./jetbrains-service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Flat input contract shared across semantic wrapper tools.
 *
 * Either provide `file + line + column` (location mode), or `symbol`
 * (symbol mode). Optional `language`, `kind`, and `fileHint` improve
 * resolution accuracy in symbol mode.
 *
 * For JS/TS, `fileHint` is strongly recommended when using `symbol`.
 */
export interface TargetInput {
	/** Project-relative file path (required with line+column for location mode). */
	file?: string;
	/** 1-based line number. */
	line?: number;
	/** 1-based column number. */
	column?: number;

	/** Symbol name to resolve. Can be qualified per language convention. */
	symbol?: string;
	/** Target language hint. Accepted values: php, python, typescript, javascript, rust, go. */
	language?: string;
	/** Symbol kind hint: class, interface, trait, enum, method, function, field, constant. */
	kind?: string;
	/** File path hint for narrowing JS/TS/Go symbol resolution. */
	fileHint?: string;
}

/**
 * A single candidate from an ambiguous resolution.
 */
export interface TargetCandidate {
	/** Human-readable label for disambiguation. */
	label: string;
	/** Project-relative file path. */
	file: string;
	/** 1-based line number (may be undefined if unknown). */
	line?: number;
	/** 1-based column number (may be undefined if unknown). */
	column?: number;
	/** Symbol kind if known (class, method, function, etc.). */
	kind?: string;
	/** Detected or provided language. */
	language?: string;
}

/**
 * Result of target resolution.
 *
 * - `ok`: canonical { file, line, column } ready for IDE tools.
 * - `ambiguous`: multiple candidates found; caller should prompt the model.
 * - `not_found`: symbol cannot be resolved; hint suggests alternatives.
 * - `error`: invalid input or service unavailability.
 */
export type ResolveResult =
	| {
			status: "ok";
			file: string;
			line: number;
			column: number;
			language?: string;
			kind?: string;
			/** How the target was resolved (location, find_class, find_symbol, file_hint, local_scan). */
			matchedBy: string;
			/** Normalized symbol name when resolved from symbol mode. */
			normalizedSymbol?: string;
	  }
	| {
			status: "ambiguous";
			summary: string;
			candidates: TargetCandidate[];
			hint: string;
	  }
	| {
			status: "not_found";
			summary: string;
			hint: string;
	  }
	| {
			status: "error";
			summary: string;
	  };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file path is inside the given project root.
 */
function isInsideProject(file: string, projectRoot: string): boolean {
	const absFile = resolve(file);
	const absRoot = resolve(projectRoot);
	const rel = relative(absRoot, absFile);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Validate and normalize a full location target.
 */
function validateLocation(
	file: string,
	line: number,
	column: number,
	cwd: string,
): ResolveResult | null {
	if (!isInsideProject(file, cwd)) {
		return {
			status: "error",
			summary: `File "${file}" is outside the current working directory.`,
		};
	}

	const rel = relative(resolve(cwd), resolve(file));
	const normalizedFile = rel.split(/[\\/]/).join("/");

	return {
		status: "ok",
		file: normalizedFile,
		line,
		column,
		matchedBy: "location",
	};
}

// ---------------------------------------------------------------------------
// Symbol shape detection (lightweight routing)
// ---------------------------------------------------------------------------

/**
 * Detect PHP symbol shape: contains backslash namespace separators or ::.
 */
function looksPhp(symbol: string): boolean {
	return symbol.includes("\\") || symbol.includes("::");
}

/**
 * Detect Python module-qualified shape: contains `:` separator.
 */
function looksPythonModule(symbol: string): boolean {
	return /:/.test(symbol);
}

/**
 * Detect dotted Python module shape (pkg.module.Symbol).
 * Only triggers when language is explicitly Python, because dotted names
 * overlap with JS/TS/Go.
 */
function looksDottedModule(symbol: string, language?: string): boolean {
	return language === "python" && /^[\w]+(\.[\w]+)+$/.test(symbol);
}

// ---------------------------------------------------------------------------
// MCP result parsing
// ---------------------------------------------------------------------------

interface RawSymbol {
	name?: string;
	qualifiedName?: string;
	kind?: string;
	file?: string;
	line?: number;
	column?: number;
	containerName?: string;
	language?: string;
}

interface RawClass {
	name?: string;
	qualifiedName?: string;
	kind?: string;
	file?: string;
	line?: number;
	column?: number;
	containerName?: string;
	language?: string;
}

interface RawFile {
	name?: string;
	path?: string;
	directory?: string;
}

function toCandidate(sym: RawSymbol, index: number): TargetCandidate {
	const file = sym.file ?? "";
	const baseLabel = sym.qualifiedName ?? sym.name ?? `candidate-${index}`;
	const parts: string[] = [baseLabel];
	if (sym.kind) parts.push(`(${sym.kind})`);
	if (sym.language) parts.push(`[${sym.language}]`);
	if (file) parts.push(`→ ${file}`);
	return {
		label: parts.join(" "),
		file,
		line: sym.line,
		column: sym.column,
		kind: sym.kind,
		language: sym.language,
	};
}

function toCandidateFromClass(cls: RawClass, index: number): TargetCandidate {
	return toCandidate(
		{
			name: cls.name,
			qualifiedName: cls.qualifiedName,
			kind: cls.kind,
			file: cls.file,
			line: cls.line,
			column: cls.column,
			containerName: cls.containerName,
			language: cls.language,
		},
		index,
	);
}

/**
 * Extract a flat array of symbol-like records from an MCP call result.
 * Handles common result shapes from findSymbol / findClass.
 */
function extractSymbols(result: unknown): RawSymbol[] {
	if (!result) return [];

	// Direct record with .content array (MCP standard)
	const record = result as Record<string, unknown>;

	// Try structuredContent first
	const structured = record.structuredContent as Record<string, unknown> | undefined;
	if (structured) {
		return extractFromStructured(structured);
	}

	// Try .content array
	const content = record.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type !== "text" || typeof b.text !== "string") continue;
			try {
				const parsed = JSON.parse(b.text) as Record<string, unknown>;
				const syms = extractFromStructured(parsed);
				if (syms.length > 0) return syms;
			} catch {
				// Not JSON, skip
			}
		}
	}

	return [];
}

function extractFromStructured(data: Record<string, unknown>): RawSymbol[] {
	// Many tools return { classes: [...], symbols: [...], files: [...] }
	// Try common container keys
	for (const key of ["symbols", "classes", "files", "interfaces", "methods", "functions", "fields", "constants"]) {
		const arr = data[key];
		if (Array.isArray(arr) && arr.length > 0) {
			const result: RawSymbol[] = [];
			for (const item of arr) {
				if (!item || typeof item !== "object") continue;
				const obj = item as Record<string, unknown>;
				const sym: RawSymbol = {
					name: typeof obj.name === "string" ? obj.name : undefined,
					qualifiedName: typeof obj.qualifiedName === "string" ? obj.qualifiedName : undefined,
					kind: typeof obj.kind === "string" ? obj.kind : undefined,
					file: typeof obj.file === "string" ? obj.file : undefined,
					line: typeof obj.line === "number" ? obj.line : undefined,
					column: typeof obj.column === "number" ? obj.column : undefined,
					containerName: typeof obj.containerName === "string" ? obj.containerName : undefined,
					language: typeof obj.language === "string" ? obj.language : undefined,
				};
				if (sym.file !== undefined || sym.name !== undefined) {
					result.push(sym);
				}
			}
			return result;
		}
	}

	// If data looks like a single result, try extracting 1-based members
	if (data.file === undefined && data.name === undefined) return [];

	return [
		{
			name: typeof data.name === "string" ? data.name : undefined,
			qualifiedName: typeof data.qualifiedName === "string" ? data.qualifiedName : undefined,
			kind: typeof data.kind === "string" ? data.kind : undefined,
			file: typeof data.file === "string" ? data.file : undefined,
			line: typeof data.line === "number" ? data.line : undefined,
			column: typeof data.column === "number" ? data.column : undefined,
			containerName: typeof data.containerName === "string" ? data.containerName : undefined,
			language: typeof data.language === "string" ? data.language : undefined,
		},
	];
}

// ---------------------------------------------------------------------------
// Resolution backends
// ---------------------------------------------------------------------------

/**
 * Resolve a PHP symbol (class, method, or function).
 *
 * PHP symbols have unambiguous `\\` namespace separators and `::` for
 * static methods. We resolve class-like symbols via findClass and
 * functions/methods via findSymbol.
 */
async function resolvePhp(
	symbol: string,
	kind: string | undefined,
	service: JetBrainsService,
	catalog: ToolCatalog,
): Promise<ResolveResult> {
	// PHP static method: App\\Service\\Foo::bar
	const methodMatch = symbol.match(/^(.+)::(\w+)$/);
	if (methodMatch) {
		const className = methodMatch[1];
		const methodName = methodMatch[2];
		return resolvePhpMethod(className, methodName, service, catalog);
	}

	// PHP class or function: try findClass first for class-like inputs
	const isClassLike = !kind || ["class", "interface", "trait", "enum"].includes(kind);

	if (isClassLike && catalog.findClass) {
		const call = await service.call("findClass", { query: symbol });
		if (call.ok) {
			const symbols = extractSymbols(call.result);
			if (symbols.length === 1 && symbols[0].file && symbols[0].line !== undefined) {
				return {
					status: "ok",
					file: symbols[0].file,
					line: symbols[0].line ?? 1,
					column: symbols[0].column ?? 1,
					kind: symbols[0].kind ?? kind,
					language: symbols[0].language ?? "PHP",
					matchedBy: "find_class",
					normalizedSymbol: symbols[0].qualifiedName ?? symbol,
				};
			}
			if (symbols.length > 1) {
				return {
					status: "ambiguous",
					summary: `Multiple matches for "${symbol}".`,
					candidates: symbols.map(toCandidate),
					hint: "Use file+line+column or a more qualified symbol.",
				};
			}
		}
	}

	// Fallback to findSymbol
	return resolveBareSymbol(symbol, "php", kind, service, catalog);
}

async function resolvePhpMethod(
	className: string,
	methodName: string,
	service: JetBrainsService,
	catalog: ToolCatalog,
): Promise<ResolveResult> {
	if (!catalog.findClass) {
		return resolveBareSymbol(`${className}::${methodName}`, "php", "method", service, catalog);
	}

	const classCall = await service.call("findClass", { query: className });
	if (!classCall.ok) {
		return {
			status: "not_found",
			summary: `Could not resolve class "${className}".`,
			hint: "Check the class name or use file+line+column targeting.",
		};
	}

	const classSymbols = extractSymbols(classCall.result);
	if (classSymbols.length !== 1 || !classSymbols[0].file) {
		if (classSymbols.length === 0) {
			return {
				status: "not_found",
				summary: `Class "${className}" not found.`,
				hint: "Check the class name or use file+line+column targeting.",
			};
		}
		return {
			status: "ambiguous",
			summary: `Multiple matches for class "${className}".`,
			candidates: classSymbols.map(toCandidateFromClass),
			hint: "Use file+line+column targeting for the class, or provide a more qualified class name.",
		};
	}

	const classFile = classSymbols[0].file;

	// Try findSymbol scoped to the class file
	if (catalog.findSymbol) {
		const symCall = await service.call("findSymbol", {
			query: methodName,
			file: classFile,
			kind: "method",
		});
		if (symCall.ok) {
			const methodSymbols = extractSymbols(symCall.result);
			if (methodSymbols.length === 1 && methodSymbols[0].file && methodSymbols[0].line !== undefined) {
				return {
					status: "ok",
					file: methodSymbols[0].file,
					line: methodSymbols[0].line ?? 1,
					column: methodSymbols[0].column ?? 1,
					kind: "method",
					language: methodSymbols[0].language ?? "PHP",
					matchedBy: "find_symbol",
					normalizedSymbol: `${classSymbols[0].qualifiedName ?? className}::${methodName}`,
				};
			}
		}
	}

	// Fallback: return class location
	return {
		status: "ok",
		file: classFile,
		line: classSymbols[0].line ?? 1,
		column: classSymbols[0].column ?? 1,
		kind: "class",
		language: classSymbols[0].language ?? "PHP",
		matchedBy: "find_class",
		normalizedSymbol: classSymbols[0].qualifiedName ?? className,
	};
}

/**
 * Resolve a Python symbol (class, method, or function).
 *
 * Accepts colon-separated (`pkg.module:Class.method`) and dotted forms
 * (`pkg.module.Class.method`). Uses findSymbol primarily; falls back to
 * findFile + fileStructure for module-level resolution.
 */
async function resolvePython(
	symbol: string,
	kind: string | undefined,
	service: JetBrainsService,
	catalog: ToolCatalog,
): Promise<ResolveResult> {
	// Parse module-qualified symbol
	// pkg.module:Class.method → module=pkg.module, member=Class.method
	// pkg.module:func → module=pkg.module, member=func
	// pkg.module.Class.method → treated as full dotted path

	let searchQuery = symbol;

	// Normalize colon to dot for findSymbol query
	if (symbol.includes(":")) {
		searchQuery = symbol.replace(/:/g, ".");
	}

	// If findSymbol is available, try direct search
	if (catalog.findSymbol) {
		const call = await service.call("findSymbol", {
			query: searchQuery,
			...(kind ? { kind } : {}),
		});
		if (call.ok) {
			const symbols = extractSymbols(call.result);
			if (symbols.length === 1 && symbols[0].file && symbols[0].line !== undefined) {
				return {
					status: "ok",
					file: symbols[0].file,
					line: symbols[0].line ?? 1,
					column: symbols[0].column ?? 1,
					kind: symbols[0].kind ?? kind,
					language: symbols[0].language ?? "Python",
					matchedBy: "find_symbol",
					normalizedSymbol: symbols[0].qualifiedName ?? searchQuery,
				};
			}
			if (symbols.length > 1) {
				return {
					status: "ambiguous",
					summary: `Multiple matches for "${symbol}".`,
					candidates: symbols.map(toCandidate),
					hint: "Use file+line+column targeting, or narrow with kind/language.",
				};
			}
		}
	}

	// Fallback: try to resolve via findClass if class-like
	if (catalog.findClass && (!kind || ["class", "interface", "enum"].includes(kind))) {
		// Extract the class name (last segment)
		const segments = searchQuery.split(".");
		const className = segments[segments.length - 1];
		const classCall = await service.call("findClass", { query: className });
		if (classCall.ok) {
			const classSymbols = extractSymbols(classCall.result);
			if (classSymbols.length === 1 && classSymbols[0].file && classSymbols[0].line !== undefined) {
				return {
					status: "ok",
					file: classSymbols[0].file,
					line: classSymbols[0].line ?? 1,
					column: classSymbols[0].column ?? 1,
					kind: classSymbols[0].kind ?? "class",
					language: classSymbols[0].language ?? "Python",
					matchedBy: "find_class",
					normalizedSymbol: classSymbols[0].qualifiedName ?? className,
				};
			}
		}
	}

	return {
		status: "not_found",
		summary: `Could not resolve Python symbol "${symbol}".`,
		hint: "Use file+line+column targeting. Try adding the module path (pkg.module:Symbol).",
	};
}

/**
 * Resolve a file-hinted symbol (primarily for JS/TS).
 *
 * Accepts:
 *  - Separate fields: fileHint="src/lib/foo.ts", symbol="Foo.bar"
 *  - Combined form in fileHint: "src/lib/foo.ts#Foo.bar"
 *  - Combined form in symbol: "src/lib/foo.ts#Foo.bar"
 */
async function resolveFileHinted(
	fileHint: string,
	symbol: string,
	kind: string | undefined,
	service: JetBrainsService,
	catalog: ToolCatalog,
): Promise<ResolveResult> {
	// Check if the symbol itself contains path#identifier
	const hashInSymbol = symbol.indexOf("#");
	let targetFile = fileHint;
	let memberName = symbol;

	if (hashInSymbol >= 0) {
		// Combined form in symbol: src/lib/foo.ts#Foo.bar
		targetFile = symbol.substring(0, hashInSymbol);
		memberName = symbol.substring(hashInSymbol + 1);
	} else if (fileHint.indexOf("#") >= 0) {
		// Combined form in fileHint
		const hashIdx = fileHint.indexOf("#");
		targetFile = fileHint.substring(0, hashIdx);
		memberName = fileHint.substring(hashIdx + 1) || symbol;
	}

	if (!targetFile || !memberName) {
		return {
			status: "error",
			summary: "File-hinted resolution requires both a file path and a symbol name.",
		};
	}

	// Resolve the file first
	let resolvedFile = targetFile;

	if (catalog.findFile) {
		const fileCall = await service.call("findFile", { query: targetFile });
		if (fileCall.ok) {
			const files = extractSymbols(fileCall.result);
			if (files.length === 1 && files[0].file) {
				resolvedFile = files[0].file;
			}
		}
	}

	// Strip member ownership (Foo.bar → bar, with Foo as container)
	let searchName = memberName;
	const dotIdx = memberName.lastIndexOf(".");
	if (dotIdx >= 0) {
		searchName = memberName.substring(dotIdx + 1);
	}

	// Try findSymbol scoped to the resolved file
	if (catalog.findSymbol) {
		const symCall = await service.call("findSymbol", {
			query: searchName,
			file: resolvedFile,
			...(kind ? { kind } : {}),
		});
		if (symCall.ok) {
			const symbols = extractSymbols(symCall.result);
			if (symbols.length === 1 && symbols[0].file && symbols[0].line !== undefined) {
				return {
					status: "ok",
					file: symbols[0].file,
					line: symbols[0].line ?? 1,
					column: symbols[0].column ?? 1,
					kind: symbols[0].kind ?? kind,
					language: symbols[0].language,
					matchedBy: "file_hint",
					normalizedSymbol: symbols[0].qualifiedName ?? memberName,
				};
			}
			if (symbols.length > 1) {
				return {
					status: "ambiguous",
					summary: `Multiple matches for "${searchName}" in ${resolvedFile}.`,
					candidates: symbols.map(toCandidate),
					hint: "Use file+line+column targeting or narrow with kind.",
				};
			}
		}
	}

	// Fallback: try findClass if the symbol looks like a class
	if (catalog.findClass && (!kind || kind === "class")) {
		const classCall = await service.call("findClass", { query: searchName });
		if (classCall.ok) {
			const classSymbols = extractSymbols(classCall.result);
			// Filter to results in the target file
			const matching = classSymbols.filter(
				(s) => s.file && (s.file === resolvedFile || s.file.endsWith(`/${resolvedFile}`)),
			);
			if (matching.length === 1 && matching[0].file && matching[0].line !== undefined) {
				return {
					status: "ok",
					file: matching[0].file,
					line: matching[0].line ?? 1,
					column: matching[0].column ?? 1,
					kind: matching[0].kind ?? "class",
					language: matching[0].language,
					matchedBy: "file_hint",
					normalizedSymbol: matching[0].qualifiedName ?? memberName,
				};
			}
		}
	}

	return {
		status: "not_found",
		summary: `Could not resolve "${memberName}" in file "${targetFile}".`,
		hint: "Use file+line+column targeting for precise results.",
	};
}

/**
 * Best-effort bare symbol resolution via findSymbol.
 *
 * Used for TS/JS (without fileHint), Rust, Go, and as a fallback for
 * other languages. Contract:
 *  - 1 result  → ok
 *  - 0 results → not_found
 *  - >1        → ambiguous
 */
async function resolveBareSymbol(
	symbol: string,
	language: string | undefined,
	kind: string | undefined,
	service: JetBrainsService,
	catalog: ToolCatalog,
): Promise<ResolveResult> {
	if (!catalog.findSymbol) {
		// Without findSymbol, try findClass as fallback for class-like inputs
		if (catalog.findClass && (!kind || ["class", "interface", "trait", "enum"].includes(kind))) {
			const call = await service.call("findClass", { query: symbol });
			if (call.ok) {
				const symbols = extractSymbols(call.result);
				if (symbols.length === 1 && symbols[0].file && symbols[0].line !== undefined) {
					return {
						status: "ok",
						file: symbols[0].file,
						line: symbols[0].line ?? 1,
						column: symbols[0].column ?? 1,
						kind: symbols[0].kind ?? kind,
						language: symbols[0].language ?? language,
						matchedBy: "find_class",
						normalizedSymbol: symbols[0].qualifiedName ?? symbol,
					};
				}
				if (symbols.length > 1) {
					return {
						status: "ambiguous",
						summary: `Multiple matches for "${symbol}".`,
						candidates: symbols.map(toCandidate),
						hint: "Use file+line+column targeting, add fileHint, or narrow with kind/language.",
					};
				}
			}
		}
		return {
			status: "not_found",
			summary: `Could not resolve "${symbol}". findSymbol is unavailable.`,
			hint: "Use file+line+column targeting or enable the JetBrains findSymbol tool.",
		};
	}

	const symCall = await service.call("findSymbol", {
		query: symbol,
		...(kind ? { kind } : {}),
	});

	if (!symCall.ok) {
		return {
			status: "error",
			summary: `findSymbol failed: ${symCall.error ?? "unknown error"}`,
		};
	}

	const symbols = extractSymbols(symCall.result);
	if (symbols.length === 1 && symbols[0].file && symbols[0].line !== undefined) {
		return {
			status: "ok",
			file: symbols[0].file,
			line: symbols[0].line ?? 1,
			column: symbols[0].column ?? 1,
			kind: symbols[0].kind ?? kind,
			language: symbols[0].language ?? language,
			matchedBy: "find_symbol",
			normalizedSymbol: symbols[0].qualifiedName ?? symbol,
		};
	}

	if (symbols.length === 0) {
		return {
			status: "not_found",
			summary: `Symbol "${symbol}" not found.`,
			hint: "Use file+line+column targeting, add fileHint, or specify language/kind.",
		};
	}

	return {
		status: "ambiguous",
		summary: `Multiple matches for "${symbol}" (${symbols.length} found).`,
		candidates: symbols.map(toCandidate),
		hint: "Use file+line+column targeting, add fileHint, or narrow with kind/language.",
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a target input to a canonical { file, line, column } target.
 *
 * @param input  - The flat target input from the model.
 * @param service - Connected JetBrainsService for tool calls.
 * @param cwd     - Project root for path validation.
 * @returns A ResolveResult indicating success, ambiguity, or failure.
 */
export async function resolveTarget(
	input: TargetInput,
	service: JetBrainsService,
	cwd: string,
): Promise<ResolveResult> {
	const catalog = service.getCatalog();
	if (!catalog) {
		return {
			status: "error",
			summary: "JetBrains service is not connected; cannot resolve targets.",
		};
	}

	// ------------------------------------------------------------------
	// Phase 1: validate input shape
	// ------------------------------------------------------------------

	const hasFullLocation = typeof input.file === "string" && input.file.trim().length > 0
		&& typeof input.line === "number" && Number.isFinite(input.line) && input.line >= 1
		&& typeof input.column === "number" && Number.isFinite(input.column) && input.column >= 1;

	const hasPartialLocation = (typeof input.line === "number" || typeof input.column === "number")
		&& !hasFullLocation;

	const hasSymbol = typeof input.symbol === "string" && input.symbol.trim().length > 0;

	if (hasPartialLocation) {
		return {
			status: "error",
			summary: "If line or column is provided, both must be provided along with file.",
		};
	}

	if (!hasFullLocation && !hasSymbol) {
		return {
			status: "error",
			summary: "Provide either file+line+column, or symbol.",
		};
	}

	// ------------------------------------------------------------------
	// Phase 2: location mode (takes precedence when both are provided)
	// ------------------------------------------------------------------

	if (hasFullLocation) {
		const file = input.file!.trim();
		const line = input.line!;
		const column = input.column!;

		const validated = validateLocation(file, line, column, cwd);
		if (validated) return validated;
	}

	// ------------------------------------------------------------------
	// Phase 3: symbol mode
	// ------------------------------------------------------------------

	const symbol = input.symbol!.trim();
	const language = input.language?.toLowerCase();
	const kind = input.kind?.toLowerCase();
	const fileHint = input.fileHint?.trim();

	// 3a. If fileHint is provided (or combined in symbol), do file-hinted resolution
	if (fileHint || symbol.includes("#")) {
		return resolveFileHinted(fileHint ?? "", symbol, kind, service, catalog);
	}

	// 3b. PHP resolution
	if (language === "php" || looksPhp(symbol)) {
		return resolvePhp(symbol, kind, service, catalog);
	}

	// 3c. Python resolution
	if (language === "python" || looksPythonModule(symbol) || looksDottedModule(symbol, language)) {
		return resolvePython(symbol, kind, service, catalog);
	}

	// 3d. Best-effort bare symbol (TS/JS, Rust, Go, and any other language)
	return resolveBareSymbol(symbol, language, kind, service, catalog);
}
