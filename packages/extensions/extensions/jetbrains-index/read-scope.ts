import { isAbsolute, relative, resolve } from "node:path";

export function isReadPathInsideCwd(input: Record<string, unknown>, cwd: string): boolean {
	const rawPath = input.path;
	if (typeof rawPath !== "string") return false;

	const trimmedPath = rawPath.trim();
	if (trimmedPath.length === 0) return false;

	const resolvedCwd = resolve(cwd);
	const resolvedTarget = isAbsolute(trimmedPath)
		? resolve(trimmedPath)
		: resolve(resolvedCwd, trimmedPath);

	const rel = relative(resolvedCwd, resolvedTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
