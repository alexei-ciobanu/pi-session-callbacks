import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	getShellConfig,
	SettingsManager,
	type ToolDefinition,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { CallbackStream } from "./callbacks.js";

const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const DEFAULT_LOG_LINES = 200;
const LOG_TRUNCATION_NOTICE_BYTES = 128;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 3_600;

const SESSION_JOB_PARAMETERS = Type.Object({
	action: StringEnum(["start", "list", "status", "wait", "logs", "stop"] as const, {
		description: "Job operation to perform",
	}),
	name: Type.Optional(Type.String({ description: "Job name" })),
	command: Type.Optional(Type.String({ description: "Bash command to run for a new job" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to Pi's cwd" })),
	lines: Type.Optional(
		Type.Integer({
			description: "Number of trailing log lines to return",
			minimum: 1,
			maximum: DEFAULT_MAX_LINES,
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: "Seconds to wait; zero returns immediately",
			minimum: 0,
			maximum: MAX_WAIT_SECONDS,
		}),
	),
});

type SessionJobParams = {
	action: "start" | "list" | "status" | "wait" | "logs" | "stop";
	name?: string;
	command?: string;
	cwd?: string;
	lines?: number;
	timeoutSeconds?: number;
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
	waitTimedOut?: boolean;
	waitedMs?: number;
	completionAcknowledged?: boolean;
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
completion_id="job-completion-$PI_JOB_NAME"
mkdir -p -- "$PI_CALLBACK_DIR/inbox"
completion_temporary="$PI_CALLBACK_DIR/inbox/.$completion_id-$$.tmp"
if ((status == 0)); then
  completion_message="Job $PI_JOB_NAME completed successfully."
else
  completion_message="Job $PI_JOB_NAME exited with status $status."
fi
if ! printf '%s' "$completion_message" > "$completion_temporary" ||
  ! mv -- "$completion_temporary" "$PI_CALLBACK_DIR/inbox/$completion_id.wake"; then
  printf 'warning: failed to publish automatic completion callback\n' >&2
  rm -f -- "$completion_temporary"
fi
temporary="$PI_JOB_DIR/.exit-code-$$.tmp"
printf '%s\n' "$status" > "$temporary"
mv -- "$temporary" "$PI_JOB_DIR/exit-code"
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

function removeLeadingUtf8ContinuationBytes(buffer: Buffer): Buffer {
	let offset = 0;
	while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1;
	return buffer.subarray(offset);
}

export async function readLogTail(logPath: string, lines: number, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
	const handle = await fsp.open(logPath, "r");
	try {
		const stat = await handle.stat();
		if (stat.size === 0) return "(no output yet)";

		const contentByteLimit = Math.max(1, maxBytes - LOG_TRUNCATION_NOTICE_BYTES);
		const length = Math.min(stat.size, contentByteLimit + 4);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
		const chunk = removeLeadingUtf8ContinuationBytes(buffer.subarray(0, bytesRead));
		const truncation = truncateTail(chunk.toString("utf8"), {
			maxBytes: contentByteLimit,
			maxLines: lines,
		});
		const selected = truncation.content.trimEnd();
		if (!selected) return "(no output yet)";

		const truncatedBeforeChunk = stat.size > length;
		const notice =
			truncatedBeforeChunk || truncation.truncatedBy === "bytes" ? "[Log truncated; showing the tail only]\n" : "";
		return `${notice}${selected}`;
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

function isTerminal(job: JobSnapshot): boolean {
	return job.status !== "starting" && job.status !== "running";
}

async function waitForJob(
	jobDirectory: string,
	jobName: string,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
	callbacks: CallbackStream,
): Promise<{
	job: JobSnapshot;
	timedOut: boolean;
	waitedMs: number;
	completionAcknowledged: boolean;
}> {
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSeconds * 1_000;
	const waitRegistration = callbacks.beginJobWait(jobName);
	try {
		while (true) {
			signal?.throwIfAborted();
			const job = await readJob(jobDirectory);
			if (isTerminal(job)) {
				const completionAcknowledged = await waitRegistration.acknowledgeCompletion();
				return {
					job,
					timedOut: false,
					waitedMs: Date.now() - startedAt,
					completionAcknowledged,
				};
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return {
					job,
					timedOut: true,
					waitedMs: Date.now() - startedAt,
					completionAcknowledged: false,
				};
			}
			await delay(Math.min(remainingMs, 100), undefined, { signal });
		}
	} finally {
		waitRegistration.release();
	}
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
	return `${job.name}: ${job.status}${pid}${exitCode}\n  ${formatStarted(job.createdAt)}\n  cwd: ${job.cwd}\n  log: ${job.logPath}`;
}

function formatAge(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 5_000) return "just now";
	const seconds = Math.floor(milliseconds / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatStarted(createdAt: string, now = Date.now()): string {
	const age = formatAge(now - Date.parse(createdAt));
	return age === "just now" ? "started just now" : `started ${age} ago`;
}

function formatCompactJob(job: JobSnapshot): string {
	const details: string[] = [job.name, job.status, formatStarted(job.createdAt)];
	if ((job.status === "running" || job.status === "starting") && job.pid !== undefined) {
		details.push(`pid ${job.pid}`);
	}
	if (job.exitCode !== undefined) details.push(`exit ${job.exitCode}`);
	return details.join(" · ");
}

function formatExpandedJob(job: JobSnapshot): string {
	const details = [
		formatCompactJob(job),
		`  started: ${job.createdAt} (${formatStarted(job.createdAt)})`,
		`  cwd: ${job.cwd}`,
		`  log: ${job.logPath}`,
	];
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
	if (params.action === "wait" && params.timeoutSeconds !== undefined) parts.push(`(${params.timeoutSeconds}s)`);
	return parts.join(" ");
}

export function createSessionJobTool(callbacks: CallbackStream, agentDirectory: string): SessionJobTool {
	return defineTool({
		name: "session_job",
		label: "Session Job",
		description:
			"Start and manage durable background jobs that continue after Pi exits. Supports start, list, status, wait, logs, and stop. Job output is written to durable logs. Commands run through Bash and can report progress with pi-callback.",
		promptSnippet: "Start and manage durable background jobs",
		promptGuidelines: [
			"Use session_job for long-running commands instead of backgrounding commands through bash.",
			"Use session_job wait for a bounded wait instead of sleeping or repeatedly polling status.",
			"Use session_job logs or status to inspect a durable job without waiting.",
		],
		parameters: SESSION_JOB_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
			if (normalized.action === "wait") {
				const result = await waitForJob(
					jobDirectory,
					name,
					normalized.timeoutSeconds ?? DEFAULT_WAIT_SECONDS,
					signal,
					callbacks,
				);
				const outcome = result.timedOut
					? "Wait timed out; job is still active."
					: result.completionAcknowledged
						? "Job reached a terminal state. Pending completion callback acknowledged."
						: "Job reached a terminal state. No pending completion callback was acknowledged.";
				return {
					content: [{ type: "text", text: `${outcome}\n${formatJob(result.job)}` }],
					details: {
						action: normalized.action,
						job: result.job,
						waitTimedOut: result.timedOut,
						waitedMs: result.waitedMs,
						completionAcknowledged: result.completionAcknowledged,
					},
				};
			}
			if (normalized.action === "logs") {
				const job = await readJob(jobDirectory);
				const header = `${formatJob(job)}\n\n`;
				const availableLogBytes = Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(header));
				const text = await readLogTail(job.logPath, normalized.lines ?? DEFAULT_LOG_LINES, availableLogBytes);
				return {
					content: [{ type: "text", text: `${header}${text}` }],
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

			const { action, job, jobs, logText, waitTimedOut, waitedMs } = result.details;
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
				const waitResult = action === "wait" ? (waitTimedOut ? " · wait timed out" : " · completion observed") : "";
				text = options.expanded
					? `${formatExpandedJob(job)}${
							action === "wait" ? `\n  wait: ${waitTimedOut ? "timed out" : "completion observed"}` : ""
						}${waitedMs === undefined ? "" : `\n  waited: ${waitedMs}ms`}`
					: `${formatCompactJob(job)}${waitResult}`;
			} else {
				text = fallback;
			}

			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});
}
