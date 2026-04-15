/**
 * Cross-platform pi CLI spawn resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(
	filePath: string,
	existsSync: (filePath: string) => boolean,
): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function resolvePiCliScript(): string | undefined {
	// Walk up from argv[1] to find pi-coding-agent root
	try {
		const entry = process.argv[1];
		if (entry) {
			let dir = path.dirname(fs.realpathSync(entry));
			while (dir !== path.dirname(dir)) {
				try {
					const pkg = JSON.parse(
						fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
					);
					if (pkg.name === "@mariozechner/pi-coding-agent") {
						const cliScript = path.join(dir, "dist", "cli.js");
						if (fs.existsSync(cliScript)) return cliScript;
						return undefined;
					}
				} catch {
					// continue walking up
				}
				dir = path.dirname(dir);
			}
		}
	} catch {
		// ignore
	}

	// Fallback: find pi binary on PATH by spawning `which pi` / `where pi`
	// Or just return undefined and let the shell resolve `pi`
	return undefined;
}

/**
 * Get the command + args to spawn a pi child process.
 * Falls back to using `pi` from PATH.
 */
export function getPiSpawnCommand(args: string[]): PiSpawnCommand {
	const piCliPath = resolvePiCliScript();
	if (piCliPath) {
		return {
			command: process.execPath,
			args: [piCliPath, ...args],
		};
	}
	return { command: "pi", args };
}
