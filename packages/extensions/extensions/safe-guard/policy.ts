import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";

export interface SafeGuardPolicy {
	/** Command substrings that bypass destructive/dangerous checks */
	allowCommandPatterns: string[];
	/** Absolute paths where writes outside CWD are always allowed */
	allowWriteOutsideCwd: string[];
	/** Paths where destructive file operations are always allowed */
	allowDestructiveInPaths: string[];
	/** Filename/path patterns that require confirmation to read */
	protectedReadPatterns: string[];
	/** Extra command substrings to treat as dangerous (added to built-ins) */
	dangerousCommandPatterns: string[];
}

// Patterns matched against the resolved absolute path (case-insensitive).
// A path is protected if it ends with any of these, or contains them as a
// path segment, or the basename matches exactly.
const DEFAULT_PROTECTED_READ_PATTERNS: string[] = [
	// env files with real secrets (tracked .env / .env.dev / .env.prod are fine)
	".env.local",
	".env.dev.local",
	".env.prod.local",
	".env.staging.local",
	".env.test.local",
	// auth / credentials
	"auth.json",
	"credentials.json",
	".netrc",
	".npmrc",
	// shell configs (may contain secrets, tokens, API keys)
	".bashrc",
	".zshrc",
	".bash_profile",
	".zprofile",
	".profile",
	".bash_history",
	".zsh_history",
	// SSH
	".ssh/id_",
	".ssh/config",
	".ssh/known_hosts",
	// Cloud / kube
	".aws/credentials",
	".aws/config",
	".kube/config",
	".gcp/",
	".config/gcloud/",
	".azure/",
	// Key / certificate files
	".pem",
	".pkcs12",
	".p12",
	".pfx",
	// Service accounts
	"service-account",
];

const DEFAULT_POLICY: SafeGuardPolicy = {
	allowCommandPatterns: [],
	allowWriteOutsideCwd: [],
	allowDestructiveInPaths: [],
	protectedReadPatterns: DEFAULT_PROTECTED_READ_PATTERNS,
	dangerousCommandPatterns: [],
};

export function getDefaultProtectedReadPatterns(): string[] {
	return [...DEFAULT_PROTECTED_READ_PATTERNS];
}

export function policyFilePath(cwd: string): string {
	return join(cwd, ".pi", "safe-guard.json");
}

export function globalPolicyFilePath(): string {
	return join(homedir(), ".pi", "agent", "safe-guard.json");
}

function readPolicyFile(filePath: string): SafeGuardPolicy | null {
	if (!existsSync(filePath)) return null;
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		return {
			...DEFAULT_POLICY,
			...raw,
			protectedReadPatterns: [
				...DEFAULT_PROTECTED_READ_PATTERNS,
				...(raw.protectedReadPatterns ?? []),
			],
		};
	} catch {
		return null;
	}
}

export function loadPolicy(cwd: string): SafeGuardPolicy {
	// Project-local policy takes precedence
	const local = readPolicyFile(policyFilePath(cwd));
	if (local) return local;

	// Fall back to global policy (~/.pi/safe-guard.json)
	const global = readPolicyFile(globalPolicyFilePath());
	if (global) return global;

	// No policy file anywhere — use built-in defaults
	return { ...DEFAULT_POLICY, protectedReadPatterns: [...DEFAULT_PROTECTED_READ_PATTERNS] };
}

function serializePolicy(policy: SafeGuardPolicy): SafeGuardPolicy {
	return {
		...policy,
		protectedReadPatterns: policy.protectedReadPatterns.filter(
			(p) => !DEFAULT_PROTECTED_READ_PATTERNS.includes(p),
		),
	};
}

export function savePolicy(cwd: string, policy: SafeGuardPolicy): void {
	const filePath = policyFilePath(cwd);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(serializePolicy(policy), null, 2) + "\n", "utf-8");
}

export function savePolicyGlobal(policy: SafeGuardPolicy): void {
	const filePath = globalPolicyFilePath();
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(serializePolicy(policy), null, 2) + "\n", "utf-8");
}

// ─── matching ───────────────────────────────────────────────────────────

function normalize(cmd: string): string {
	return cmd.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isCommandAllowed(policy: SafeGuardPolicy, command: string): boolean {
	const n = normalize(command);
	return policy.allowCommandPatterns.some((p) => n.includes(normalize(p)));
}

export function isPathInList(list: string[], targetPath: string): boolean {
	const resolved = resolve(targetPath);
	return list.some((entry) => {
		const r = resolve(entry);
		return resolved === r || resolved.startsWith(r + "/");
	});
}

export function isProtectedReadPath(policy: SafeGuardPolicy, filePath: string): boolean {
	const resolved = resolve(filePath).toLowerCase();
	const name = basename(resolved);

	for (const pattern of policy.protectedReadPatterns) {
		const p = pattern.toLowerCase();
		// Exact basename match
		if (name === p) return true;
		// Path ends with pattern (e.g., ".ssh/id_rsa" matches ".ssh/id_")
		if (resolved.endsWith(p)) return true;
		// Path contains pattern as a segment (e.g., "/home/user/.ssh/id_rsa" contains ".ssh/id_")
		if (resolved.includes("/" + p) || resolved.includes(p + "/")) return true;
	}

	return false;
}

// ─── mutations ──────────────────────────────────────────────────────────

export function addCommandAllow(cwd: string, pattern: string): void {
	const policy = loadPolicy(cwd);
	const n = normalize(pattern);
	if (!policy.allowCommandPatterns.some((p) => normalize(p) === n)) {
		policy.allowCommandPatterns.push(pattern.trim());
		savePolicyGlobal(policy);
	}
}

export function addWritePathAllow(cwd: string, path: string): void {
	const policy = loadPolicy(cwd);
	const resolved = resolve(path);
	if (!policy.allowWriteOutsideCwd.includes(resolved)) {
		policy.allowWriteOutsideCwd.push(resolved);
		savePolicyGlobal(policy);
	}
}

export function addProtectedReadPattern(cwd: string, pattern: string): void {
	const policy = loadPolicy(cwd);
	if (!policy.protectedReadPatterns.includes(pattern)) {
		policy.protectedReadPatterns.push(pattern);
		savePolicyGlobal(policy);
	}
}

export function removeProtectedReadPattern(cwd: string, pattern: string): void {
	const policy = loadPolicy(cwd);
	const idx = policy.protectedReadPatterns.indexOf(pattern);
	if (idx >= 0) {
		policy.protectedReadPatterns.splice(idx, 1);
		savePolicyGlobal(policy);
	}
}
