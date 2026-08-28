import { spawn } from "node:child_process";
import { type Dirent, constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	getShellConfig,
	SettingsManager,
	type ToolDefinition,
	type TruncationResult,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { CallbackStream } from "./callbacks.js";

const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const DEFAULT_LOG_LINES = 200;
const LOG_TRUNCATION_NOTICE_BYTES = 128;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 3_600;
const WAIT_PROGRESS_POLL_MS = 500;
const WAIT_PROGRESS_HEARTBEAT_MS = 5_000;
export const DEFAULT_JOB_LIST_LIMIT = 10;
export const MAX_JOB_LIST_LIMIT = 1_000;
export const JOB_LIST_OUTPUT_TTL_MS = 24 * 60 * 60 * 1_000;
const JOB_LIST_TEMPORARY_PREFIX = "pi-session-job-list-";
const MAX_LIST_PATH_DISPLAY_BYTES = DEFAULT_MAX_BYTES - 4 * 1_024;

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
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum jobs to return for list (default ${DEFAULT_JOB_LIST_LIMIT})`,
			minimum: 1,
			maximum: MAX_JOB_LIST_LIMIT,
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			description: "Number of ordered jobs to skip for list (default 0)",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
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
	limit?: number;
	offset?: number;
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
	totalJobs?: number;
	listLimit?: number;
	listOffset?: number;
	nextOffset?: number;
	listTruncation?: TruncationResult;
	fullListOutputPath?: string;
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
	return jobs.sort((left, right) => {
		const leftActive = !isTerminal(left);
		const rightActive = !isTerminal(right);
		if (leftActive !== rightActive) return leftActive ? -1 : 1;
		const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
		if (byCreatedAt !== 0) return byCreatedAt;
		return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	});
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

function removeTrailingIncompleteUtf8Bytes(buffer: Buffer): Buffer {
	if (buffer.length === 0) return buffer;
	let sequenceStart = buffer.length - 1;
	while (sequenceStart >= 0 && (buffer[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1;
	if (sequenceStart < 0) return buffer.subarray(0, 0);

	const leadingByte = buffer[sequenceStart];
	const expectedLength =
		leadingByte <= 0x7f
			? 1
			: leadingByte >= 0xc2 && leadingByte <= 0xdf
				? 2
				: leadingByte >= 0xe0 && leadingByte <= 0xef
					? 3
					: leadingByte >= 0xf0 && leadingByte <= 0xf4
						? 4
						: undefined;
	if (expectedLength === undefined || buffer.length - sequenceStart >= expectedLength) return buffer;
	return buffer.subarray(0, sequenceStart);
}

export async function readLogTail(logPath: string, lines: number, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
	const handle = await fsp.open(logPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return "(log unavailable: not a regular file)";
		if (stat.size === 0) return "(no output yet)";

		const contentByteLimit = Math.max(1, maxBytes - LOG_TRUNCATION_NOTICE_BYTES);
		const length = Math.min(stat.size, contentByteLimit + 4);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
		const chunk = removeTrailingIncompleteUtf8Bytes(
			removeLeadingUtf8ContinuationBytes(buffer.subarray(0, bytesRead)),
		);
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
	onProgress?: (job: JobSnapshot, waitedMs: number) => void,
): Promise<{
	job: JobSnapshot;
	timedOut: boolean;
	waitedMs: number;
	completionAcknowledged: boolean;
}> {
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSeconds * 1_000;
	const waitRegistration = callbacks.beginJobWait(jobName);
	let nextProgressAt = startedAt;
	let firstObservation = true;
	try {
		while (true) {
			signal?.throwIfAborted();
			const job = await readJob(jobDirectory);
			const observedAt = Date.now();
			if (isTerminal(job)) {
				const endedAt = job.endedAt ? Date.parse(job.endedAt) : Number.NaN;
				const completedWithinDeadline = Number.isFinite(endedAt)
					? endedAt <= deadline
					: observedAt <= deadline || firstObservation;
				if (!completedWithinDeadline) {
					return {
						job,
						timedOut: true,
						waitedMs: observedAt - startedAt,
						completionAcknowledged: false,
					};
				}
				const completionAcknowledged = await waitRegistration.acknowledgeCompletion();
				return {
					job,
					timedOut: false,
					waitedMs: Date.now() - startedAt,
					completionAcknowledged,
				};
			}

			firstObservation = false;
			const remainingMs = deadline - observedAt;
			if (remainingMs <= 0) {
				return {
					job,
					timedOut: true,
					waitedMs: observedAt - startedAt,
					completionAcknowledged: false,
				};
			}
			if (onProgress && observedAt >= nextProgressAt) {
				onProgress(job, observedAt - startedAt);
				nextProgressAt = observedAt + WAIT_PROGRESS_POLL_MS;
			}
			await delay(Math.min(remainingMs, 100), undefined, { signal });
		}
	} finally {
		waitRegistration.release();
	}
}

async function withOptionalLogTail(
	baseText: string,
	job: JobSnapshot,
	lines: number | undefined,
): Promise<{ text: string; logText?: string }> {
	if (lines === undefined) return { text: baseText };
	const separator = "\n\nRecent output:\n";
	const metadataLines = `${baseText}${separator}`.split("\n").length - 1;
	const availableLogLines = Math.max(1, DEFAULT_MAX_LINES - metadataLines);
	const availableLogBytes = Math.max(
		1,
		DEFAULT_MAX_BYTES - Buffer.byteLength(baseText) - Buffer.byteLength(separator),
	);
	const logText = await readLogTail(job.logPath, Math.min(lines, availableLogLines), availableLogBytes);
	const combined = `${baseText}${separator}${logText}`;
	const bounded = truncateTail(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return { text: bounded.content, logText };
}

function waitProgressSignature(job: JobSnapshot, waitedMs: number, logText: string | undefined): string {
	const heartbeat = Math.floor(waitedMs / WAIT_PROGRESS_HEARTBEAT_MS);
	return `${job.status}\0${job.exitCode ?? ""}\0${heartbeat}\0${logText ?? ""}`;
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

function formatListSummary(totalJobs: number, offset: number, pageLength: number): string {
	if (totalJobs === 0) return "No durable jobs in this session.";
	if (pageLength === 0) return `No jobs at offset ${offset}. Total jobs: ${totalJobs}.`;
	const first = offset + 1;
	const last = offset + pageLength;
	const next = last < totalJobs ? ` Next page: offset=${last}.` : "";
	return `Showing jobs ${first}–${last} of ${totalJobs}.${next}`;
}

type JobListOutput = {
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

function displayListOutputPath(fullOutputPath: string): { text: string; truncated: boolean } {
	const bounded = truncateHead(JSON.stringify(fullOutputPath), {
		maxBytes: MAX_LIST_PATH_DISPLAY_BYTES,
		maxLines: 1,
	});
	return {
		text: bounded.truncated ? `${bounded.content}…` : bounded.content,
		truncated: bounded.truncated,
	};
}

function listTruncationNotice(truncation: TruncationResult, fullOutputPath: string): string {
	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	const displayedPath = displayListOutputPath(fullOutputPath);
	const pathNote = displayedPath.truncated ? " (display truncated; exact path retained in tool result details)" : "";
	return `[List page truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}); ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full page saved to: ${displayedPath.text}${pathNote}]`;
}

export function formatBoundedJobListText(fullText: string, fullOutputPath: string): JobListOutput {
	const initial = truncateHead(fullText, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!initial.truncated) return { text: fullText };

	let truncation = initial;
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const notice = listTruncationNotice(truncation, fullOutputPath);
		const next = truncateHead(fullText, {
			maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(`\n\n${notice}`)),
			maxLines: Math.max(1, DEFAULT_MAX_LINES - 2),
		});
		if (next.outputBytes === truncation.outputBytes && next.outputLines === truncation.outputLines) break;
		truncation = next;
	}
	const notice = listTruncationNotice(truncation, fullOutputPath);
	const text = `${truncation.content.trimEnd()}\n\n${notice}`;
	const safetyBound = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (safetyBound.truncated) {
		return {
			text: "[List page truncated. The full page path exceeded the display limit; its exact value is retained in tool result details.]",
			truncation,
			fullOutputPath,
		};
	}
	return {
		text: safetyBound.content,
		truncation,
		fullOutputPath,
	};
}

async function cleanupExpiredJobListOutputs(temporaryRoot: string, now = Date.now()): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(temporaryRoot, { withFileTypes: true });
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory() || !entry.name.startsWith(JOB_LIST_TEMPORARY_PREFIX)) return;
			const directory = path.join(temporaryRoot, entry.name);
			try {
				const stat = await fsp.stat(directory);
				if (now - stat.mtimeMs > JOB_LIST_OUTPUT_TTL_MS) {
					await fsp.rm(directory, { recursive: true, force: true });
				}
			} catch {
				// Temporary-output cleanup is best-effort.
			}
		}),
	);
}

export async function boundJobListOutput(fullText: string, temporaryRoot = os.tmpdir()): Promise<JobListOutput> {
	const initial = truncateHead(fullText, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!initial.truncated) return { text: fullText };

	await cleanupExpiredJobListOutputs(temporaryRoot);
	const temporaryDirectory = await fsp.mkdtemp(path.join(temporaryRoot, JOB_LIST_TEMPORARY_PREFIX));
	await chmodPrivate(temporaryDirectory, 0o700);
	const fullOutputPath = path.join(temporaryDirectory, "page.txt");
	await withFileMutationQueue(fullOutputPath, async () => {
		await fsp.writeFile(fullOutputPath, fullText, { encoding: "utf8", mode: 0o600 });
	});
	await chmodPrivate(fullOutputPath, 0o600);
	return formatBoundedJobListText(fullText, fullOutputPath);
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
	if (params.action === "list" && (params.limit !== undefined || params.offset !== undefined)) {
		parts.push(`(limit ${params.limit ?? DEFAULT_JOB_LIST_LIMIT}, offset ${params.offset ?? 0})`);
	}
	return parts.join(" ");
}

export function createSessionJobTool(callbacks: CallbackStream, agentDirectory: string): SessionJobTool {
	return defineTool({
		name: "session_job",
		label: "Session Job",
		description: `Start and manage durable background jobs that continue after Pi exits. Supports start, list, status, wait, logs, and stop. List returns ${DEFAULT_JOB_LIST_LIMIT} jobs by default and supports limit/offset pagination. Tool output is bounded to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; an oversized list page is saved to a temporary file. Job output is written to durable logs. Commands run through Bash and can report progress with pi-callback.`,
		promptSnippet: "Start and manage durable background jobs",
		promptGuidelines: [
			"Use session_job for long-running commands instead of backgrounding commands through bash.",
			"Use session_job wait for a bounded wait instead of sleeping or repeatedly polling status.",
			"Pass lines with session_job status or wait to include a bounded recent-output tail when useful.",
			"Use session_job logs or status to inspect a durable job without waiting.",
		],
		parameters: SESSION_JOB_PARAMETERS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
				const limit = normalized.limit ?? DEFAULT_JOB_LIST_LIMIT;
				const offset = normalized.offset ?? 0;
				const page = jobs.slice(offset, offset + limit);
				const summary = formatListSummary(jobs.length, offset, page.length);
				const fullText = page.length === 0 ? summary : `${summary}\n\n${page.map(formatJob).join("\n\n")}`;
				const output = await boundJobListOutput(fullText);
				const nextOffset = offset + page.length < jobs.length ? offset + page.length : undefined;
				return {
					content: [{ type: "text", text: output.text }],
					details: {
						action: normalized.action,
						jobs: page,
						totalJobs: jobs.length,
						listLimit: limit,
						listOffset: offset,
						nextOffset,
						listTruncation: output.truncation,
						fullListOutputPath: output.fullOutputPath,
					},
				};
			}

			const name = requireName(normalized.name);
			const jobDirectory = path.join(jobsDirectory, name);
			if (normalized.action === "status") {
				const job = await readJob(jobDirectory);
				const output = await withOptionalLogTail(formatJob(job), job, normalized.lines);
				return {
					content: [{ type: "text", text: output.text }],
					details: { action: normalized.action, job, logText: output.logText },
				};
			}
			if (normalized.action === "wait") {
				let lastProgressSignature: string | undefined;
				let progressActive = true;
				let progressInFlight = false;
				const publishProgress = onUpdate
					? (job: JobSnapshot, waitedMs: number) => {
							if (progressInFlight) return;
							progressInFlight = true;
							void (async () => {
								const baseText = `Wait in progress.\n${formatJob(job)}`;
								const output = await withOptionalLogTail(baseText, job, normalized.lines);
								if (!progressActive || signal?.aborted) return;
								const signature = waitProgressSignature(job, waitedMs, output.logText);
								if (signature === lastProgressSignature) return;
								lastProgressSignature = signature;
								onUpdate({
									content: [{ type: "text", text: output.text }],
									details: {
										action: normalized.action,
										job,
										waitedMs,
										logText: output.logText,
									},
								});
							})()
								.catch(() => {
									// Partial progress is best-effort and must not change wait semantics.
								})
								.finally(() => {
									progressInFlight = false;
								});
						}
					: undefined;
				let result: Awaited<ReturnType<typeof waitForJob>>;
				try {
					result = await waitForJob(
						jobDirectory,
						name,
						normalized.timeoutSeconds ?? DEFAULT_WAIT_SECONDS,
						signal,
						callbacks,
						publishProgress,
					);
				} finally {
					progressActive = false;
				}
				const outcome = result.timedOut
					? isTerminal(result.job)
						? "Wait timed out before completion was observed."
						: "Wait timed out; job is still active."
					: result.completionAcknowledged
						? "Job reached a terminal state. Pending completion callback acknowledged."
						: "Job reached a terminal state. No pending completion callback was acknowledged.";
				const output = await withOptionalLogTail(
					`${outcome}\n${formatJob(result.job)}`,
					result.job,
					normalized.lines,
				);
				return {
					content: [{ type: "text", text: output.text }],
					details: {
						action: normalized.action,
						job: result.job,
						waitTimedOut: result.timedOut,
						waitedMs: result.waitedMs,
						completionAcknowledged: result.completionAcknowledged,
						logText: output.logText,
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

			const { action, job, jobs, logText, waitTimedOut, waitedMs, totalJobs, listOffset, fullListOutputPath } =
				result.details;
			let text: string;
			if (action === "list") {
				const page = jobs ?? [];
				const summary = formatListSummary(totalJobs ?? page.length, listOffset ?? 0, page.length);
				const formattedJobs = page
					.map(options.expanded ? formatExpandedJob : formatCompactJob)
					.join(options.expanded ? "\n\n" : "\n");
				const fullPage =
					options.expanded && fullListOutputPath ? `\n  full page: ${JSON.stringify(fullListOutputPath)}` : "";
				text = formattedJobs ? `${summary}${fullPage}\n${formattedJobs}` : `${summary}${fullPage}`;
			} else if (action === "logs" && job) {
				text = options.expanded
					? `${formatExpandedJob(job)}\n\n${logText ?? "(no output yet)"}`
					: (logText ?? "(no output yet)");
			} else if (job) {
				const waitState =
					waitTimedOut === undefined ? "waiting" : waitTimedOut ? "timed out" : "completion observed";
				const waitResult =
					action !== "wait"
						? ""
						: waitTimedOut === undefined
							? " · waiting"
							: waitTimedOut
								? " · wait timed out"
								: " · completion observed";
				const liveWaitDuration =
					action === "wait" && waitTimedOut === undefined && waitedMs !== undefined
						? ` · waited ${formatAge(waitedMs)}`
						: "";
				text = options.expanded
					? `${formatExpandedJob(job)}${action === "wait" ? `\n  wait: ${waitState}` : ""}${
							waitedMs === undefined ? "" : `\n  waited: ${waitedMs}ms`
						}`
					: `${formatCompactJob(job)}${waitResult}${liveWaitDuration}`;
				if (logText !== undefined) text += `\n\n${logText}`;
			} else {
				text = fallback;
			}

			const boundedText =
				action === "list" && fullListOutputPath
					? formatBoundedJobListText(text, fullListOutputPath).text
					: (action === "list" ? truncateHead : truncateTail)(text, {
							maxBytes: DEFAULT_MAX_BYTES,
							maxLines: DEFAULT_MAX_LINES,
						}).content;
			return new Text(theme.fg("toolOutput", boundedText), 0, 0);
		},
	});
}
