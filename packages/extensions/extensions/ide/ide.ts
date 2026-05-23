/**
 * IDE Bridge Extension — reads IDE state from ~/.pi/ide/ JSON files.
 *
 * Matches the current Pi process to an IDE using:
 *  1. PID ancestry (walk parent process tree)
 *  2. Workspace match (cwd inside workspaceFolders)
 *  3. Most recent timestamp fallback
 *
 * Shows IDE state in footer status bar and provides commands to insert
 * selection or current file into the conversation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ─── Paths ────────────────────────────────────────────────────────────────

const PI_DIR = path.join(os.homedir(), ".pi");
const IDE_DIR = path.join(PI_DIR, "ide");

// ─── Types ────────────────────────────────────────────────────────────────

interface IdeFile {
    pid: number;
    ideName: string;
    ideVersion: string;
    workspaceFolders: string[];
    currentFile: string | null;
    selection: {
        text: string;
        startLine: number;
        endLine: number;
    } | null;
    timestamp: number;
}

// ─── State ────────────────────────────────────────────────────────────────

let currentIde: IdeFile | null = null;
let lastCtx: ExtensionContext | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastRawContent: string | null = null;
let fileWatcher: fs.FSWatcher | null = null;

// ─── PID ancestry ─────────────────────────────────────────────────────────

function isParentPid(targetPid: number): boolean {
    let pid = process.pid;
    const seen = new Set<number>();

    while (pid > 1) {
        if (pid === targetPid) {
            return true;
        }
        if (seen.has(pid)) {
            break;
        }
        seen.add(pid);

        try {
            const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
            const parentMatch = status.match(/^PPid:\s+(\d+)/m);
            if (parentMatch) {
                pid = parseInt(parentMatch[1], 10);
            } else {
                break;
            }
        } catch {
            // /proc not available (macOS/Windows) or process gone
            return false;
        }
    }
    return false;
}

// ─── Workspace matching ───────────────────────────────────────────────────

function workspaceContains(workspaceFolders: string[], cwd: string): boolean {
    const normalizedCwd = cwd.endsWith("/") ? cwd : cwd + "/";
    for (const folder of workspaceFolders) {
        const normalized = folder.endsWith("/") ? folder : folder + "/";
        if (normalizedCwd.startsWith(normalized)) {
            return true;
        }
    }
    return false;
}

// ─── File I/O ─────────────────────────────────────────────────────────────

function readIdeFiles(): IdeFile[] {
    const results: IdeFile[] = [];

    try {
        if (!fs.existsSync(IDE_DIR)) {
            return results;
        }

        const files = fs.readdirSync(IDE_DIR).filter((f) => f.endsWith(".json"));

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(IDE_DIR, file), "utf-8");
                const data = JSON.parse(content) as IdeFile;

                // Skip stale files (older than 24 hours)
                if (data.timestamp && Date.now() - data.timestamp > 86400000) {
                    continue;
                }

                results.push(data);
            } catch {
                // Skip invalid JSON
            }
        }
    } catch {
        // Directory doesn't exist yet
    }

    return results;
}

// ─── Matching logic ──────────────────────────────────────────────────────

function findMatchingIde(): IdeFile | null {
    const all = readIdeFiles();
    if (all.length === 0) {
        return null;
    }

    // Priority 1: PID ancestry match
    for (const ide of all) {
        if (isParentPid(ide.pid)) {
            return ide;
        }
    }

    // Priority 2: Workspace match
    const cwd = process.cwd();
    for (const ide of all) {
        if (workspaceContains(ide.workspaceFolders, cwd)) {
            return ide;
        }
    }

    // No PID or workspace match — don't claim a connection
    return null;
}

// ─── Formatting ───────────────────────────────────────────────────────────

function getShortPath(filePath: string, maxLen = 40): string {
    const basename = path.basename(filePath);
    const dirname = path.dirname(filePath);

    if (filePath.length <= maxLen) {
        return filePath;
    }

    const parent = path.basename(dirname);
    const short = `.../${parent}/${basename}`;

    if (short.length <= maxLen) {
        return short;
    }

    return `.../${basename}`;
}

function formatIdeStatus(ide: IdeFile, theme: Theme): string {
    const ideName = theme.fg("accent", ide.ideName);
    const hint = theme.fg("dim", " (alt+i to insert)");

    if (ide.selection) {
        const lines = ide.selection.endLine - ide.selection.startLine + 1;
        const fileName = path.basename(ide.currentFile || "unknown");
        return `[${ideName}] ${theme.fg("success", `${lines} lines`)} selected from ${theme.fg("muted", fileName)}${hint}`;
    }

    if (ide.currentFile) {
        const short = getShortPath(ide.currentFile, 30);
        return `[${ideName}] ${theme.fg("muted", short)}${hint}`;
    }

    return `[${ideName}]${hint}`;
}

function formatIdeForContext(ide: IdeFile): string {
    const parts: string[] = [];

    parts.push(`IDE: ${ide.ideName} ${ide.ideVersion}`);
    parts.push(`PID: ${ide.pid}`);

    if (ide.workspaceFolders.length > 0) {
        parts.push(`Workspace: ${ide.workspaceFolders.join(", ")}`);
    }

    if (ide.currentFile) {
        parts.push(`Current file: ${ide.currentFile}`);
    }

    if (ide.selection) {
        const fileRef = ide.currentFile
            ? `${ide.currentFile}:${ide.selection.startLine}-${ide.selection.endLine}`
            : "unknown";
        parts.push(`Selection (${fileRef}):`);
        parts.push(ide.selection.text);
    }

    return parts.join("\n");
}

// ─── Status update ────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const ide = findMatchingIde();

    if (!ide) {
        currentIde = null;
        ctx.ui.setStatus("ide", ctx.ui.theme.fg("dim", "IDE: not connected"));
        return;
    }

    currentIde = ide;
    ctx.ui.setStatus("ide", formatIdeStatus(ide, ctx.ui.theme));
}

// ─── File watching ────────────────────────────────────────────────────────

function checkForChanges() {
    try {
        let newContent: string | null = null;

        if (fs.existsSync(IDE_DIR)) {
            const files = fs.readdirSync(IDE_DIR).filter((f) => f.endsWith(".json"));
            newContent = files.map((f) => fs.readFileSync(path.join(IDE_DIR, f), "utf-8")).join("\0");
        }

        if (newContent !== lastRawContent) {
            lastRawContent = newContent;
            if (lastCtx) {
                updateStatus(lastCtx);
            }
        }
    } catch {
        // Ignore read errors
    }
}

function startFileWatcher() {
    try {
        if (!fs.existsSync(IDE_DIR)) {
            fs.mkdirSync(IDE_DIR, { recursive: true });
        }

        // Watch the directory for changes
        fileWatcher = fs.watch(IDE_DIR, { persistent: false }, () => {
            checkForChanges();
        });
        fileWatcher.on("error", () => {
            // Directory might be empty, that's ok
        });
    } catch {
        // Directory doesn't exist yet, polling will handle it
    }

    // Poll every 500ms as fallback (fs.watch can be unreliable)
    pollInterval = setInterval(checkForChanges, 500);
}

function stopFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
    }
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function handleIdeCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ide = findMatchingIde();

    if (!ide) {
        ctx.ui.notify("No IDE state available", "warning");
        return;
    }

    const text = formatIdeForContext(ide) + "\n";
    ctx.ui.setEditorText(text);
}

async function handleIdeInsert(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ide = findMatchingIde();

    if (!ide) {
        ctx.ui.notify("No IDE state available", "warning");
        return;
    }

    if (ide.selection) {
        ctx.ui.pasteToEditor(`${ide.selection.text}\n`);
    } else if (ide.currentFile) {
        ctx.ui.pasteToEditor(`${ide.currentFile}\n`);
    } else {
        ctx.ui.notify("No selection or file to insert", "warning");
    }
}

async function handleIdeClear(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    // Clear all IDE state files (graceful)
    try {
        if (fs.existsSync(IDE_DIR)) {
            const files = fs.readdirSync(IDE_DIR).filter((f) => f.endsWith(".json"));
            for (const file of files) {
                fs.unlinkSync(path.join(IDE_DIR, file));
            }
        }
    } catch {
        // Ignore
    }

    currentIde = null;
    ctx.ui.setStatus("ide", undefined);
    ctx.ui.notify("IDE state cleared", "info");
}

async function handleIdeInfo(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const all = readIdeFiles();

    if (all.length === 0) {
        ctx.ui.notify("No IDE state files found", "info");
        return;
    }

    const lines = all.map((ide) => {
        const file = ide.currentFile ? path.basename(ide.currentFile) : "(none)";
        const sel = ide.selection ? ` [${ide.selection.endLine - ide.selection.startLine + 1} lines]` : "";
        return `  ${ide.ideName} (${ide.ideVersion}): ${file}${sel}`;
    });

    ctx.ui.notify(`IDE state (${all.length} active):\n${lines.join("\n")}`, "info");
}

// ─── Extension entry ─────────────────────────────────────────────────────

export default function ideExtension(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;

        startFileWatcher();
        checkForChanges();
        updateStatus(ctx);
    });

    pi.on("session_shutdown", async () => {
        stopFileWatcher();
        currentIde = null;
    });

    // Commands
    pi.registerCommand("ide", {
        description: "Show current IDE state and insert into conversation",
        handler: handleIdeCommand,
    });

    pi.registerCommand("ide-insert", {
        description: "Insert IDE selection (or current file) into editor",
        handler: handleIdeInsert,
    });

    pi.registerCommand("ide-clear", {
        description: "Clear all IDE state files",
        handler: handleIdeClear,
    });

    pi.registerCommand("ide-info", {
        description: "Show all active IDE state files",
        handler: handleIdeInfo,
    });

    // Command: @selection — insert selection text from matched IDE
    pi.registerCommand("selection", {
        description: "Insert IDE selection into conversation (shortcut: alt+i)",
        handler: async (_args, ctx) => {
            const ide = findMatchingIde();

            if (!ide) {
                ctx.ui.notify("No IDE state available", "warning");
                return;
            }

            if (ide.selection) {
                const fileRef = ide.currentFile
                    ? `${ide.currentFile}:${ide.selection.startLine}-${ide.selection.endLine}`
                    : "unknown";
                const text = `Selection from ${fileRef}:\n${ide.selection.text}\n`;
                ctx.ui.setEditorText(text);
            } else {
                ctx.ui.notify("No selection in IDE", "warning");
            }
        },
    });

    // Command: @currentFile — insert current file reference from matched IDE
    pi.registerCommand("currentFile", {
        description: "Insert IDE current file path into conversation (shortcut: alt+o)",
        handler: async (_args, ctx) => {
            const ide = findMatchingIde();

            if (!ide) {
                ctx.ui.notify("No IDE state available", "warning");
                return;
            }

            if (ide.currentFile) {
                const text = `Referencing ${ide.currentFile}\n`;
                ctx.ui.setEditorText(text);
            } else {
                ctx.ui.notify("No file open in IDE", "warning");
            }
        },
    });

    // Shortcut: alt+i to insert selection or file
    pi.registerShortcut("alt+i", {
        description: "Insert IDE selection (or current file) into editor",
        handler: async (ctx) => {
            const ide = findMatchingIde();

            if (!ide) {
                ctx.ui.notify("No IDE connected", "warning");
                return;
            }

            if (ide.selection) {
                const fileRef = ide.currentFile
                    ? `${ide.currentFile}:${ide.selection.startLine}-${ide.selection.endLine}`
                    : "unknown";
                ctx.ui.pasteToEditor(`Referencing ${fileRef}\n`);
            } else if (ide.currentFile) {
                ctx.ui.pasteToEditor(`Referencing ${ide.currentFile}\n`);
            } else {
                ctx.ui.notify("No selection or file to insert", "warning");
            }
        },
    });

    // Shortcut: alt+o to insert current file path
    pi.registerShortcut("alt+o", {
        description: "Insert IDE current file path into editor",
        handler: async (ctx) => {
            const ide = findMatchingIde();

            if (!ide) {
                ctx.ui.notify("No IDE connected", "warning");
                return;
            }

            if (ide.currentFile) {
                ctx.ui.pasteToEditor(`Referencing ${ide.currentFile}\n`);
            } else {
                ctx.ui.notify("No file open in IDE", "warning");
            }
        },
    });
}
