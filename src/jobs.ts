import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, getShellConfig, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { CallbackStream } from "./callbacks.js";

const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MAX_LOG_READ_BYTES = 256 * 1024;
const DEFAULT_LOG_LINES = 200;

const SESSION_JOB_PARAMETERS = Type.Object({
	action: StringEnum(["start", "list", "status", "logs", "stop"] as const, {
		description: "Job operation to perform",
	}),
	name: Type.Optional(Type.String({ description: "Job name" })),
	command: Type.Optional(Type.String({ description: "Bash command to run for a new job" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to Pi's cwd" })),
	lines: Type.Optional(
		Type.Integer({ description: "Number of trailing log lines to return", minimum: 1, maximum: 2_000 }),
	),
});

type SessionJobParams = {
	action: "start" | "list" | "status" | "logs" | "stop";
	name?: string;
	command?: string;
	cwd?: string;
	lines?: number;
};

type JobMetadata = {
	name: string;
	command: string;
	cwd: string;
	createdAt: string;
	pid?: number;
};

export type JobStatus = "starting" | "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export type JobSnapshot = JobMetadata & {
	status: JobStatus;
	exitCode?: number;
	endedAt?: string;
	logPath: string;
};

type SessionJobDetails = {
	action: SessionJobParams["action"];
	job?: JobSnapshot;
	jobs?: JobSnapshot[];
	logPath?: string;
	logText?: string;
};

type SessionJobTool = ToolDefinition<typeof SESSION_JOB_PARAMETERS, SessionJobDetails>;

async function chmodPrivate(filePath: string, mode: number): Promise<void> {
	try {
		await fsp.chmod(filePath, mode);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await fsp.rename(temporaryPath, filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			await fsp.rm(temporaryPath, { force: true });
			throw error;
		}
		await fsp.rm(filePath, { force: true });
		await fsp.rename(temporaryPath, filePath);
	}
	await chmodPrivate(filePath, 0o600);
}

function requireName(name: string | undefined): string {
	if (!name) throw new Error("name is required for this action");
	if (!JOB_NAME_PATTERN.test(name)) {
		throw new Error(
			"name must start with an alphanumeric character and contain at most 80 alphanumerics, '.', '_', or '-'",
		);
	}
	return name;
}

export function validateJobName(name: string): boolean {
	return JOB_NAME_PATTERN.test(name);
}

function generateJobName(): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return `pi-job-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function readJob(jobDirectory: string): Promise<JobSnapshot> {
	const metadata = JSON.parse(await fsp.readFile(path.join(jobDirectory, "job.json"), "utf8")) as JobMetadata;
	const logPath = path.join(jobDirectory, "job.log");
	const stopped = await readOptionalText(path.join(jobDirectory, "stopped"));
	const exitCodeText = await readOptionalText(path.join(jobDirectory, "exit-code"));

	if (stopped !== undefined) {
		const stat = await fsp.stat(path.join(jobDirectory, "stopped"));
		return { ...metadata, status: "stopped", endedAt: stat.mtime.toISOString(), logPath };
	}
	if (exitCodeText !== undefined) {
		const exitCode = Number(exitCodeText.trim());
		const stat = await fsp.stat(path.join(jobDirectory, "exit-code"));
		return {
			...metadata,
			status: exitCode === 0 ? "succeeded" : "failed",
			exitCode,
			endedAt: stat.mtime.toISOString(),
			logPath,
		};
	}
	if (metadata.pid === undefined) return { ...metadata, status: "starting", logPath };
	return { ...metadata, status: isProcessAlive(metadata.pid) ? "running" : "interrupted", logPath };
}

async function listJobs(jobsDirectory: string): Promise<JobSnapshot[]> {
	const entries = await fsp.readdir(jobsDirectory, { withFileTypes: true });
	const jobs: JobSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			jobs.push(await readJob(path.join(jobsDirectory, entry.name)));
		} catch {
			// Ignore incomplete directories left by a failed launch.
		}
	}
	return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function shellPathConversion(variableName: string, nativeVariableName: string): string {
	if (process.platform !== "win32") return `${variableName}="$${nativeVariableName}"`;
	return `if command -v cygpath >/dev/null 2>&1; then
  ${variableName}="$(cygpath -u "$${nativeVariableName}")"
elif command -v wslpath >/dev/null 2>&1; then
  ${variableName}="$(wslpath -u "$${nativeVariableName}")"
else
  ${variableName}="$${nativeVariableName}"
fi`;
}

function buildRunner(callbacks: CallbackStream): string {
	return `set +e
umask 077
${callbacks.bootstrap()}
${shellPathConversion("PI_JOB_DIR", "PI_JOB_DIR_NATIVE")}
${shellPathConversion("PI_JOB_CWD", "PI_JOB_CWD_NATIVE")}
export PI_JOB_NAME
cd -- "$PI_JOB_CWD"
printf '%s\n' running > "$PI_JOB_DIR/state"
bash -c "$PI_JOB_COMMAND"
status=$?
temporary="$PI_JOB_DIR/.exit-code-$$.tmp"
printf '%s\n' "$status" > "$temporary"
mv -- "$temporary" "$PI_JOB_DIR/exit-code"
if ((status == 0)); then
  pi-callback "Job $PI_JOB_NAME completed successfully."
else
  pi-callback "Job $PI_JOB_NAME exited with status $status."
fi
exit "$status"
`;
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

async function startJob(
	params: SessionJobParams,
	callbacks: CallbackStream,
	agentDirectory: string,
	cwd: string,
): Promise<JobSnapshot> {
	const jobsDirectory = callbacks.jobsDirectory;
	if (!jobsDirectory) throw new Error("Callback stream is not initialized");
	if (!params.command?.trim()) throw new Error("command is required for start");

	const name = params.name ? requireName(params.name) : generateJobName();
	const jobDirectory = path.join(jobsDirectory, name);
	try {
		await fsp.mkdir(jobDirectory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`job already exists: ${name}`);
		throw error;
	}
	await chmodPrivate(jobDirectory, 0o700);

	const resolvedCwd = path.resolve(cwd, params.cwd ?? ".");
	const cwdStat = await fsp.stat(resolvedCwd).catch(() => undefined);
	if (!cwdStat?.isDirectory()) {
		await fsp.rm(jobDirectory, { recursive: true, force: true });
		throw new Error(`working directory does not exist: ${resolvedCwd}`);
	}

	const metadata: JobMetadata = {
		name,
		command: params.command,
		cwd: resolvedCwd,
		createdAt: new Date().toISOString(),
	};
	const metadataPath = path.join(jobDirectory, "job.json");
	const logPath = path.join(jobDirectory, "job.log");
	await writeJsonAtomic(metadataPath, metadata);
	const logHandle = await fsp.open(logPath, "a", 0o600);

	try {
		const settings = SettingsManager.create(cwd, agentDirectory);
		const shell = getShellConfig(settings.getShellPath());
		const runner = buildRunner(callbacks);
		const commandFromStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, runner], {
			cwd: resolvedCwd,
			detached: true,
			env: {
				...process.env,
				PI_JOB_COMMAND: params.command,
				PI_JOB_CWD_NATIVE: resolvedCwd,
				PI_JOB_DIR_NATIVE: jobDirectory,
				PI_JOB_NAME: name,
			},
			stdio: [commandFromStdin ? "pipe" : "ignore", logHandle.fd, logHandle.fd],
			windowsHide: true,
		});
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(runner);
		}
		await waitForSpawn(child);
		if (!child.pid) throw new Error("background supervisor did not report a process id");
		metadata.pid = child.pid;
		await writeJsonAtomic(metadataPath, metadata);
		child.unref();
	} catch (error) {
		await fsp.rm(jobDirectory, { recursive: true, force: true });
		throw error;
	} finally {
		await logHandle.close();
	}

	return { ...metadata, status: "running", logPath };
}

async function readLogTail(logPath: string, lines: number): Promise<string> {
	const handle = await fsp.open(logPath, "r");
	try {
		const stat = await handle.stat();
		const length = Math.min(stat.size, MAX_LOG_READ_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, stat.size - length);
		const text = buffer.toString("utf8");
		const selected = text
			.split(/\r?\n/)
			.slice(-lines - 1)
			.join("\n")
			.trimEnd();
		const prefix = stat.size > length ? `[Showing the last ${length} bytes]\n` : "";
		return `${prefix}${selected}` || "(no output yet)";
	} finally {
		await handle.close();
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !isProcessAlive(pid);
}

async function runTaskkill(pid: number): Promise<void> {
	const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
}

async function stopJob(jobDirectory: string): Promise<JobSnapshot> {
	const job = await readJob(jobDirectory);
	if (job.status !== "running" && job.status !== "starting") return job;
	if (job.pid === undefined) throw new Error(`job has no supervisor process id: ${job.name}`);

	if (process.platform === "win32") {
		await runTaskkill(job.pid);
	} else {
		try {
			process.kill(-job.pid, "SIGTERM");
		} catch {
			process.kill(job.pid, "SIGTERM");
		}
		if (!(await waitForExit(job.pid, 1_000))) {
			try {
				process.kill(-job.pid, "SIGKILL");
			} catch {
				process.kill(job.pid, "SIGKILL");
			}
		}
	}

	await fsp.writeFile(path.join(jobDirectory, "stopped"), `${new Date().toISOString()}\n`, { mode: 0o600 });
	return readJob(jobDirectory);
}

function formatJob(job: JobSnapshot): string {
	const pid = job.pid === undefined ? "" : ` pid=${job.pid}`;
	const exitCode = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
	return `${job.name}: ${job.status}${pid}${exitCode}\n  cwd: ${job.cwd}\n  log: ${job.logPath}`;
}

function formatCompactJob(job: JobSnapshot): string {
	const details: string[] = [job.name, job.status];
	if ((job.status === "running" || job.status === "starting") && job.pid !== undefined) {
		details.push(`pid ${job.pid}`);
	}
	if (job.exitCode !== undefined) details.push(`exit ${job.exitCode}`);
	return details.join(" · ");
}

function formatExpandedJob(job: JobSnapshot): string {
	const details = [formatCompactJob(job), `  cwd: ${job.cwd}`, `  log: ${job.logPath}`];
	if (job.endedAt) details.push(`  ended: ${job.endedAt}`);
	return details.join("\n");
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function formatToolCall(params: Partial<SessionJobParams>): string {
	const parts = ["session_job"];
	if (params.action) parts.push(params.action);
	if (params.name) parts.push(params.name);
	if (params.action === "logs" && params.lines !== undefined) parts.push(`(${params.lines} lines)`);
	return parts.join(" ");
}

export function createSessionJobTool(callbacks: CallbackStream, agentDirectory: string): SessionJobTool {
	return defineTool({
		name: "session_job",
		label: "Session Job",
		description:
			"Start and manage durable background jobs that continue after Pi exits. Supports start, list, status, logs, and stop. Job output is written to durable logs. Commands run through Bash and can report progress with pi-callback.",
		promptSnippet: "Start and manage durable background jobs",
		promptGuidelines: [
			"Use session_job for long-running commands instead of backgrounding commands through bash.",
			"Use session_job logs or status to inspect a durable job; do not poll aggressively while waiting for its callback.",
		],
		parameters: SESSION_JOB_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = params as SessionJobParams;
			const jobsDirectory = callbacks.jobsDirectory;
			if (!jobsDirectory) throw new Error("Callback stream is not initialized");

			if (normalized.action === "start") {
				const job = await startJob(normalized, callbacks, agentDirectory, ctx.cwd);
				return {
					content: [{ type: "text", text: `Started durable job.\n${formatJob(job)}` }],
					details: { action: normalized.action, job },
				};
			}
			if (normalized.action === "list") {
				const jobs = await listJobs(jobsDirectory);
				const text = jobs.length === 0 ? "No durable jobs in this session." : jobs.map(formatJob).join("\n\n");
				return { content: [{ type: "text", text }], details: { action: normalized.action, jobs } };
			}

			const name = requireName(normalized.name);
			const jobDirectory = path.join(jobsDirectory, name);
			if (normalized.action === "status") {
				const job = await readJob(jobDirectory);
				return {
					content: [{ type: "text", text: formatJob(job) }],
					details: { action: normalized.action, job },
				};
			}
			if (normalized.action === "logs") {
				const job = await readJob(jobDirectory);
				const text = await readLogTail(job.logPath, normalized.lines ?? DEFAULT_LOG_LINES);
				return {
					content: [{ type: "text", text: `${formatJob(job)}\n\n${text}` }],
					details: { action: normalized.action, job, logPath: job.logPath, logText: text },
				};
			}

			const job = await stopJob(jobDirectory);
			return {
				content: [{ type: "text", text: `Stopped durable job.\n${formatJob(job)}` }],
				details: { action: normalized.action, job },
			};
		},
		renderCall(args, theme, context) {
			const params = args as Partial<SessionJobParams>;
			const label = context.argsComplete ? formatToolCall(params) : `${formatToolCall(params)} …`;
			const command =
				params.action === "start" && params.command ? `\n${theme.fg("toolOutput", `$ ${params.command}`)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold(label))}${command}`, 0, 0);
		},
		renderResult(result, options, theme) {
			const fallback = resultText(result);
			if (!result.details) {
				return new Text(theme.fg("toolOutput", fallback), 0, 0);
			}

			const { action, job, jobs, logText } = result.details;
			let text: string;
			if (action === "list") {
				if (!jobs || jobs.length === 0) {
					text = "No durable jobs in this session.";
				} else {
					text = jobs
						.map(options.expanded ? formatExpandedJob : formatCompactJob)
						.join(options.expanded ? "\n\n" : "\n");
				}
			} else if (action === "logs" && job) {
				text = options.expanded
					? `${formatExpandedJob(job)}\n\n${logText ?? "(no output yet)"}`
					: (logText ?? "(no output yet)");
			} else if (job) {
				text = options.expanded ? formatExpandedJob(job) : formatCompactJob(job);
			} else {
				text = fallback;
			}

			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});
}
