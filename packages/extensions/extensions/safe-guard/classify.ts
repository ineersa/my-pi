export type BashClassification =
	| { kind: "block"; reason: string }
	| { kind: "destructive"; reason: string }
	| { kind: "dangerousGit"; reason: string }
	| { kind: "sensitiveInfo"; reason: string }
	| { kind: "customDangerous"; reason: string }
	| { kind: "allow" };

const SUDO_RE = /\bsudo\b/;

const DESTRUCTIVE_RES: RegExp[] = [
	/\brm\b/,
	/\brmdir\b/,
	/\bgit\s+clean\b/,
	/\bgit\s+reset\b.*--hard/,
	/\bgit\s+checkout\b.*--\s*\.\s*$/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/\bchmod\s+[0-7]{3,4}\b/,
	/\bchown\s+-[rR]\b/,
	/\bmv\b.*\/dev\/null/,
];

const DANGEROUS_GIT_RES: RegExp[] = [
	/\bgit\s+push\b.*(-f\b|--force\b)/,
	/\bgit\s+branch\s+-[dD]\b/,
	/\bgit\s+tag\s+-d\b/,
	/\bgit\s+rebase\b/,
	/\bgit\s+reflog\s+expire/,
];

// Commands that expose environment variables (may contain secrets/tokens)
const SENSITIVE_INFO_RES: RegExp[] = [
	/^\s*env\b/,
	/^\s*printenv\b/,
	/\benv\s*\|/,
	/\bprintenv\s*\|/,
];

export { DESTRUCTIVE_RES, DANGEROUS_GIT_RES, SENSITIVE_INFO_RES };

export function classifyBash(
	command: string,
	extraDangerousPatterns: string[],
): BashClassification {
	// 1. Hard block: sudo — never allowlisted, never asked
	if (SUDO_RE.test(command)) {
		return { kind: "block", reason: "sudo commands are not allowed" };
	}

	// 2. Built-in destructive patterns
	for (const re of DESTRUCTIVE_RES) {
		if (re.test(command)) {
			return { kind: "destructive", reason: "Destructive command" };
		}
	}

	// 3. Built-in dangerous git patterns
	for (const re of DANGEROUS_GIT_RES) {
		if (re.test(command)) {
			return { kind: "dangerousGit", reason: "Dangerous git operation" };
		}
	}

	// 4. Sensitive info exposure (env, printenv)
	for (const re of SENSITIVE_INFO_RES) {
		if (re.test(command)) {
			return { kind: "sensitiveInfo", reason: "Exposes environment variables" };
		}
	}

	// 5. User-defined dangerous patterns from policy
	const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
	for (const pattern of extraDangerousPatterns) {
		if (normalized.includes(pattern.toLowerCase().trim())) {
			return { kind: "customDangerous", reason: "Matched custom dangerous pattern" };
		}
	}

	return { kind: "allow" };
}
