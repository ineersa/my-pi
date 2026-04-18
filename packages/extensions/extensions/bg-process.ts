import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type ExtensionAPI, getAgentDir, getShellConfig } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const BG_PROMPT_MS = 15_000;

interface BgProcess {
	pid: number;
	command: string;
	logFile: string;
	startedAt: number;
	finished: boolean;
	exitCode: number | null;
	stoppedByUser?: boolean;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function createBgProcessShellEnv(
	env: NodeJS.ProcessEnv = process.env,
	agentDir: string = getAgentDir(),
): NodeJS.ProcessEnv {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = env[pathKey] ?? "";
	const binDir = join(agentDir, "bin");
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const updatedPath = pathEntries.includes(binDir)
		? currentPath
		: [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...env,
		[pathKey]: updatedPath,
	};
}

export function getBgProcessLogFilePath(now: number = Date.now(), tempDir: string = tmpdir()): string {
	return join(tempDir, `my-pi-bg-${now}.log`);
}

export default function bgProcessExtension(pi: ExtensionAPI): void {
	const bgProcesses = new Map<number, BgProcess>();

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command. If it is still running after 15 seconds, ask whether to move it to the background. Use bg_status to inspect or stop background processes.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Seconds before prompting to background (optional)" })),
		}) as any,
		async execute(
			_toolCallId,
			params: { command: string; timeout?: number },
			signal,
			_onUpdate,
			ctx,
		) {
			const { command } = params;
			const promptAfterMs = params.timeout ? Math.max(1, params.timeout) * 1000 : BG_PROMPT_MS;

			return new Promise((resolve) => {
				let stdout = "";
				let stderr = "";
				let settled = false;
				let backgrounded = false;

				const { shell, args } = getShellConfig();
				const child = spawn(shell, [...args, command], {
					cwd: process.cwd(),
					env: createBgProcessShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				const childPid = child.pid ?? 0;

				const finalizeBackgroundProcess = (code: number | null) => {
					const proc = bgProcesses.get(childPid);
					if (proc) {
						proc.finished = true;
						proc.exitCode = code;
						try {
							writeFileSync(proc.logFile, stdout + stderr);
						} catch {
							// Final log write failed — non-critical.
						}
					}

					const fullOutput = stdout + stderr;
					const tail = fullOutput.slice(-3000);
					const truncated = fullOutput.length > 3000 ? `[...truncated]\n${tail}` : tail;

					pi.sendUserMessage(
						`[BG_PROCESS_DONE] PID ${childPid} finished (exit ${code ?? "?"})\nCommand: ${command}\n\nOutput (last 3000 chars):\n${truncated}`,
						{ deliverAs: "followUp" },
					);
				};

				child.stdout?.on("data", (d: Buffer) => {
					const chunk = d.toString();
					stdout += chunk;
					if (backgrounded) {
						const logFile = bgProcesses.get(childPid)?.logFile;
						if (!logFile) {
							return;
						}
						try {
							appendFileSync(logFile, chunk);
						} catch {
							// Log append failed — non-critical.
						}
					}
				});

				child.stderr?.on("data", (d: Buffer) => {
					const chunk = d.toString();
					stderr += chunk;
					if (backgrounded) {
						const logFile = bgProcesses.get(childPid)?.logFile;
						if (!logFile) {
							return;
						}
						try {
							appendFileSync(logFile, chunk);
						} catch {
							// Log append failed — non-critical.
						}
					}
				});

				const promptTimer = setTimeout(async () => {
					if (settled || !ctx.hasUI) {
						return;
					}

					const moveToBackground = await ctx.ui.confirm(
						"Long-running command",
						`This command is still running after ${promptAfterMs / 1000}s. Move it to the background?`,
					);

					if (settled || !moveToBackground) {
						return;
					}

					settled = true;
					backgrounded = true;
					child.unref();

					const logFile = getBgProcessLogFilePath();
					writeFileSync(logFile, stdout + stderr);

					const proc: BgProcess = {
						pid: childPid,
						command,
						logFile,
						startedAt: Date.now(),
						finished: false,
						exitCode: null,
					};
					bgProcesses.set(childPid, proc);

					const preview = (stdout + stderr).slice(0, 500);
					resolve({
						content: [
							{
								type: "text",
								text: `Moved to background.\nPID: ${childPid}\nLog: ${logFile}\nStop: kill ${childPid}\n\nOutput so far:\n${preview}\n\nYou will be notified automatically when it finishes.`,
							},
						],
						details: {},
					});
				}, promptAfterMs);

				child.on("close", (code) => {
					if (backgrounded) {
						// Skip notification if the user already stopped this process
						const proc = bgProcesses.get(childPid);
						if (proc?.stoppedByUser) {
							proc.finished = true;
							proc.exitCode = code;
							return;
						}
						finalizeBackgroundProcess(code);
						return;
					}

					if (settled) {
						return;
					}

					settled = true;
					clearTimeout(promptTimer);

					const output = (stdout + stderr).trim();
					const exitInfo = code === 0 ? "" : `\n[Exit code: ${code}]`;
					resolve({ content: [{ type: "text", text: output + exitInfo }], details: {} });
				});

				child.on("error", (err) => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(promptTimer);
					resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], details: {} });
				});

				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							if (settled) {
								return;
							}
							settled = true;
							clearTimeout(promptTimer);
							try {
								child.kill();
							} catch {
								// Process already exited.
							}
							resolve({ content: [{ type: "text", text: "Command cancelled." }], details: {} });
						},
						{ once: true },
					);
				}
			});
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Process Status",
		description: "Check status, view output, or stop backgrounded processes.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("log"), Type.Literal("stop")], {
				description: "list=show all, log=view output, stop=kill process",
			}),
			pid: Type.Optional(Type.Number({ description: "PID of the process (required for log/stop)" })),
		}) as any,
		async execute(_toolCallId, params: { action: "list" | "log" | "stop"; pid?: number }) {
			const { action, pid } = params;

			if (action === "list") {
				if (bgProcesses.size === 0) {
					return { content: [{ type: "text", text: "No background processes." }], details: {} };
				}
				const lines = [...bgProcesses.values()].map((p) => {
					const status = p.finished
						? `⚪ stopped (exit ${p.exitCode ?? "?"})`
						: isAlive(p.pid)
							? "running"
							: "⚪ stopped";
					return `PID: ${p.pid} | ${status} | Log: ${p.logFile}\n  Cmd: ${p.command}`;
				});
				return { content: [{ type: "text", text: lines.join("\n\n") }], details: {} };
			}

			if (!pid) {
				return {
					content: [{ type: "text", text: "Error: pid is required for log/stop" }],
					details: {},
				};
			}

			const proc = bgProcesses.get(pid);

			if (action === "log") {
				const logFile = proc?.logFile;
				if (logFile && existsSync(logFile)) {
					try {
						const content = readFileSync(logFile, "utf-8");
						const tail = content.slice(-5000);
						const truncated =
							content.length > 5000 ? `[...truncated, showing last 5000 chars]\n${tail}` : tail;
						return { content: [{ type: "text", text: truncated || "(empty)" }], details: {} };
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text", text: `Error reading log: ${msg}` }],
							details: {},
						};
					}
				}
				return { content: [{ type: "text", text: "No log available for this PID." }], details: {} };
			}

			if (action === "stop") {
				const proc = bgProcesses.get(pid);
				try {
					if (proc) {
						proc.stoppedByUser = true;
					}
					process.kill(pid, "SIGTERM");
					if (proc) {
						proc.finished = true;
						proc.exitCode = null;
					}
					return { content: [{ type: "text", text: `Process ${pid} terminated.` }], details: {} };
				} catch {
					if (proc) {
						proc.finished = true;
						proc.exitCode = null;
					}
					return { content: [{ type: "text", text: `Process ${pid} not found (already stopped?).` }], details: {} };
				}
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const [pid, proc] of bgProcesses) {
			if (!proc.finished) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// Process already exited.
				}
			}
		}
		bgProcesses.clear();
	});
}
