/**
 * Shared diagnostics protocol: open file → sync → wait for index.
 *
 * Both the ProblemsTracker (post-edit/write diagnostics) and the public
 * `ide_diagnostics` wrapper need the same preflight sequence before
 * requesting IDE diagnostics for a specific file.
 *
 * This module extracts that shared sequence so it's defined once.
 *
 * The caller handles the actual diagnostics request and result
 * processing (e.g. baseline comparison in ProblemsTracker, raw TOON
 * response in the diagnostics wrapper).
 */
import type { JetBrainsService } from "./jetbrains-service.js";

/**
 * Run the diagnostics preflight protocol for a single file.
 *
 * 1. Best-effort open the file in the IDE (silently ignores failure).
 * 2. Sync the file with the IDE index.
 * 3. Wait for the IDE index to be ready.
 *
 * Returns `{ ready: true }` on success.
 * Returns `{ ready: false, message }` if a critical step (sync or
 * index readiness) fails.  The caller decides how to handle failure:
 * the ProblemsTracker skips diagnostics; the public wrapper may still
 * attempt the backend call and let it fail naturally.
 */
export async function prepareFileForDiagnostics(
	service: JetBrainsService,
	relativeFilePath: string,
): Promise<{ ready: boolean; message?: string }> {
	// Step 1 — best-effort open (silent if unsupported)
	await service.openFile(relativeFilePath);

	// Step 2 — sync the file with the IDE index
	const synced = await service.syncFiles([relativeFilePath]);
	if (!synced) {
		return {
			ready: false,
			message: `Failed to sync ${relativeFilePath} with the IDE index.`,
		};
	}

	// Step 3 — wait for index readiness
	const readiness = await service.waitForIndexReady();
	if (!readiness.ready) {
		return {
			ready: false,
			message: readiness.message ?? "IDE index is not ready.",
		};
	}

	return { ready: true };
}
