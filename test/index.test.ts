import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCallbackBootstrap,
	CallbackStream,
	jobCompletionFileName,
	parseCallbackFileName,
} from "../src/callbacks.js";
import { createSessionJobTool, readLogTail, validateJobName } from "../src/jobs.js";

const temporaryDirectories: string[] = [];

const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function renderedText(component: { render(width: number): string[] } | undefined): string {
	return (
		component
			?.render(120)
			.map((line) => line.trimEnd())
			.join("\n") ?? ""
	);
}

type SentMessage = {
	message: { content: string; customType: string };
	options: { triggerTurn?: boolean };
};

type AppendedEntry = {
	customType: string;
	data: unknown;
};

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-session-callbacks-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for condition");
}

function createContext(cwd: string, sessionId = "test-session"): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

function createCallbackStream(rescanIntervalMs = 25): {
	callbacks: CallbackStream;
	messages: SentMessage[];
	entries: AppendedEntry[];
} {
	const messages: SentMessage[] = [];
	const entries: AppendedEntry[] = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
			messages.push({ message, options });
		},
	} as unknown as Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
	return { callbacks: new CallbackStream(pi, { rescanIntervalMs }), entries, messages };
}

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("callback inbox", () => {
	it("classifies complete waking and quiet callback files", () => {
		expect(parseCallbackFileName("callback-1.wake")).toEqual({ wake: true });
		expect(parseCallbackFileName("callback-2.quiet")).toEqual({ wake: false });
		expect(parseCallbackFileName(jobCompletionFileName("tests-linux_1.0"))).toEqual({
			wake: true,
			jobName: "tests-linux_1.0",
		});
		expect(parseCallbackFileName(".callback-2.tmp")).toBeUndefined();
		expect(parseCallbackFileName("notes.txt")).toBeUndefined();
	});

	it("quotes native callback paths in the Bash bootstrap", () => {
		const bootstrap = buildCallbackBootstrap("C:\\callback's inbox", "win32");
		expect(bootstrap).toContain("export PI_CALLBACK_DIR_NATIVE='C:\\callback'\"'\"'s inbox'");
		expect(bootstrap).toContain("cygpath -u");
		expect(bootstrap).toContain("wslpath -u");
	});

	it("delivers queued files and removes them from the inbox", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const { callbacks, entries, messages } = createCallbackStream();
		const context = createContext(agentDirectory);
		await callbacks.start(agentDirectory, "queued", context);
		const inbox = path.join(agentDirectory, "callbacks", "queued", "inbox");
		await writeFile(path.join(inbox, "one.quiet"), "progress", "utf8");
		await writeFile(path.join(inbox, "two.wake"), "finished", "utf8");

		await waitFor(() => entries.length === 1 && messages.length === 1);

		expect(entries[0]?.customType).toBe("session-callback-status");
		expect(entries[0]?.data).toMatchObject({ message: "progress" });
		expect(messages[0]?.message.content).toBe("finished");
		expect(messages[0]?.options.triggerTurn).toBe(true);
		callbacks.stop();
	});

	it("renders a quiet update without ever sending it to the agent", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const { callbacks, entries, messages } = createCallbackStream();
		const context = createContext(agentDirectory);
		await callbacks.start(agentDirectory, "quiet", context);
		const root = path.join(agentDirectory, "callbacks", "quiet");
		await writeFile(path.join(root, "inbox", "one.quiet"), "epoch 5/10", "utf8");

		await waitFor(() => entries.length === 1);
		expect(messages).toHaveLength(0);
		expect(await readdir(path.join(root, "inbox"))).toEqual([]);

		await writeFile(path.join(root, "inbox", "two.wake"), "training complete", "utf8");
		await waitFor(() => messages.length === 1);
		expect(messages[0]?.message.content).toBe("training complete");
		expect(messages[0]?.message.content).not.toContain("epoch 5/10");
		expect(messages[0]?.options.triggerTurn).toBe(true);
		callbacks.stop();
	});
});

describe("session_job", () => {
	it("reads exact trailing lines with or without a final newline", async () => {
		const directory = await createTemporaryDirectory();
		const logPath = path.join(directory, "job.log");

		await writeFile(logPath, "first\nsecond\nthird", "utf8");
		expect(await readLogTail(logPath, 1)).toBe("third");
		expect(await readLogTail(logPath, 2)).toBe("second\nthird");

		await writeFile(logPath, "first\nsecond\nthird\n", "utf8");
		expect(await readLogTail(logPath, 1)).toBe("third");
		expect(await readLogTail(logPath, 2)).toBe("second\nthird");
	});

	it("returns a bounded UTF-8-safe tail with a truncation notice", async () => {
		const directory = await createTemporaryDirectory();
		const logPath = path.join(directory, "job.log");
		await writeFile(logPath, `${"🙂".repeat(20_000)}\nfinal line`, "utf8");

		const output = await readLogTail(logPath, 2, DEFAULT_MAX_BYTES);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(output).toContain("[Log truncated; showing the tail only]");
		expect(output).not.toContain("�");
		expect(output).toMatch(/final line$/);
	});

	it("returns an empty-log placeholder", async () => {
		const directory = await createTemporaryDirectory();
		const logPath = path.join(directory, "job.log");
		await writeFile(logPath, "", "utf8");

		expect(await readLogTail(logPath, 20)).toBe("(no output yet)");
	});

	it("validates portable explicit names", () => {
		expect(validateJobName("tests-linux_1.0")).toBe(true);
		expect(validateJobName("-bad")).toBe(false);
		expect(validateJobName("has spaces")).toBe(false);
	});

	it("waits for success and acknowledges the automatic completion callback", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-success-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-success",
			{ action: "start", name: "wait-success", command: "sleep 0.1; printf 'done\\n'" },
			undefined,
			undefined,
			context,
		);
		const waitResult = await tool.execute(
			"wait-success",
			{ action: "wait", name: "wait-success", timeoutSeconds: 2 },
			undefined,
			undefined,
			context,
		);

		expect(waitResult.details?.job?.status).toBe("succeeded");
		expect(waitResult.details?.waitTimedOut).toBe(false);
		expect(waitResult.details?.completionAcknowledged).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(messages).toHaveLength(0);
		callbacks.stop();
	});

	it("delivers the normal callback after wait times out", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-timeout-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-timeout",
			{ action: "start", name: "wait-timeout", command: "sleep 0.15" },
			undefined,
			undefined,
			context,
		);
		const waitResult = await tool.execute(
			"wait-timeout",
			{ action: "wait", name: "wait-timeout", timeoutSeconds: 0.01 },
			undefined,
			undefined,
			context,
		);

		expect(waitResult.details?.job?.status).toBe("running");
		expect(waitResult.details?.waitTimedOut).toBe(true);
		expect(waitResult.details?.completionAcknowledged).toBe(false);
		await waitFor(() => messages.length === 1);
		expect(messages[0]?.message.content).toBe("Job wait-timeout completed successfully.");
		callbacks.stop();
	});

	it("wait zero returns an immediate running snapshot without replacing status", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-zero-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-zero",
			{ action: "start", name: "wait-zero", command: "sleep 30" },
			undefined,
			undefined,
			context,
		);
		const statusResult = await tool.execute(
			"status-wait-zero",
			{ action: "status", name: "wait-zero" },
			undefined,
			undefined,
			context,
		);
		const waitResult = await tool.execute(
			"wait-zero",
			{ action: "wait", name: "wait-zero", timeoutSeconds: 0 },
			undefined,
			undefined,
			context,
		);

		expect(statusResult.details?.job?.status).toBe("running");
		expect(waitResult.details?.job?.status).toBe(statusResult.details?.job?.status);
		expect(waitResult.details?.waitTimedOut).toBe(true);
		await tool.execute("stop-wait-zero", { action: "stop", name: "wait-zero" }, undefined, undefined, context);
		callbacks.stop();
	});

	it("wait reports a failed exit without a duplicate callback", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-failure-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-failure",
			{ action: "start", name: "wait-failure", command: "sleep 0.1; exit 7" },
			undefined,
			undefined,
			context,
		);
		const waitResult = await tool.execute(
			"wait-failure",
			{ action: "wait", name: "wait-failure", timeoutSeconds: 2 },
			undefined,
			undefined,
			context,
		);

		expect(waitResult.details?.job?.status).toBe("failed");
		expect(waitResult.details?.job?.exitCode).toBe(7);
		expect(waitResult.details?.completionAcknowledged).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(messages).toHaveLength(0);
		callbacks.stop();
	});

	it("coordinates concurrent waiters without delivering a completion callback", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-concurrent-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-concurrent",
			{ action: "start", name: "wait-concurrent", command: "sleep 0.1" },
			undefined,
			undefined,
			context,
		);
		const results = await Promise.all([
			tool.execute(
				"wait-concurrent-1",
				{ action: "wait", name: "wait-concurrent", timeoutSeconds: 2 },
				undefined,
				undefined,
				context,
			),
			tool.execute(
				"wait-concurrent-2",
				{ action: "wait", name: "wait-concurrent", timeoutSeconds: 2 },
				undefined,
				undefined,
				context,
			),
		]);

		expect(results.map((result) => result.details?.job?.status)).toEqual(["succeeded", "succeeded"]);
		expect(results.filter((result) => result.details?.completionAcknowledged)).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(messages).toHaveLength(0);
		callbacks.stop();
	});

	it("releases callback delivery when wait is cancelled", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "wait-cancel-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		await tool.execute(
			"start-wait-cancel",
			{ action: "start", name: "wait-cancel", command: "sleep 0.15" },
			undefined,
			undefined,
			context,
		);
		const controller = new AbortController();
		const waitPromise = tool.execute(
			"wait-cancel",
			{ action: "wait", name: "wait-cancel", timeoutSeconds: 2 },
			controller.signal,
			undefined,
			context,
		);
		setTimeout(() => controller.abort(), 25);

		await expect(waitPromise).rejects.toThrow();
		await waitFor(() => messages.length === 1);
		expect(messages[0]?.message.content).toBe("Job wait-cancel completed successfully.");
		callbacks.stop();
	});

	it("delivers a durable job completion after the callback stream restarts", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const first = createCallbackStream();
		const context = createContext(workspace);
		await first.callbacks.start(agentDirectory, "wait-resume-session", context);
		const tool = createSessionJobTool(first.callbacks, agentDirectory);

		await tool.execute(
			"start-wait-resume",
			{ action: "start", name: "wait-resume", command: "sleep 0.1" },
			undefined,
			undefined,
			context,
		);
		first.callbacks.stop();

		const jobDirectory = path.join(agentDirectory, "callbacks", "wait-resume-session", "jobs", "wait-resume");
		await waitFor(async () => {
			try {
				await readFile(path.join(jobDirectory, "exit-code"), "utf8");
				return true;
			} catch {
				return false;
			}
		});

		const resumed = createCallbackStream();
		await resumed.callbacks.start(agentDirectory, "wait-resume-session", context);
		await waitFor(() => resumed.messages.length === 1);
		expect(resumed.messages[0]?.message.content).toBe("Job wait-resume completed successfully.");
		resumed.callbacks.stop();
	});

	it("renders compact action-aware calls and results", () => {
		const { callbacks } = createCallbackStream();
		const tool = createSessionJobTool(callbacks, "/agent");
		const job = {
			name: "training",
			command: "train",
			cwd: "/workspace",
			createdAt: "2026-07-22T00:00:00.000Z",
			pid: 123,
			status: "succeeded" as const,
			exitCode: 0,
			endedAt: "2026-07-22T01:00:00.000Z",
			logPath: "/callbacks/jobs/training/job.log",
		};

		const call = tool.renderCall?.(
			{ action: "status", name: "training" },
			identityTheme as never,
			{ argsComplete: true, cwd: "/workspace", toolCallId: "call-render" } as never,
		);
		expect(renderedText(call)).toBe("session_job status training");

		const result = {
			content: [{ type: "text" as const, text: "verbose model-facing result" }],
			details: { action: "status" as const, job },
		};
		const collapsed = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace", toolCallId: "result-render", args: { action: "status", name: "training" } } as never,
		);
		const collapsedText = renderedText(collapsed);
		expect(collapsedText).toBe("training · succeeded · exit 0");
		expect(collapsedText).not.toContain("/workspace");

		const expanded = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace", toolCallId: "result-render", args: { action: "status", name: "training" } } as never,
		);
		const expandedText = renderedText(expanded);
		expect(expandedText).toContain("cwd: /workspace");
		expect(expandedText).toContain("log: /callbacks/jobs/training/job.log");
	});

	it("shows the submitted Bash command in the start call", () => {
		const { callbacks } = createCallbackStream();
		const tool = createSessionJobTool(callbacks, "/agent");
		const component = tool.renderCall?.(
			{ action: "start", name: "training", command: "python train.py --epochs 10\necho done" },
			identityTheme as never,
			{ argsComplete: true, cwd: "/workspace", toolCallId: "start-render" } as never,
		);

		expect(renderedText(component)).toBe("session_job start training\n$ python train.py --epochs 10\necho done");
	});

	it("renders bounded wait calls and timeout results", () => {
		const { callbacks } = createCallbackStream();
		const tool = createSessionJobTool(callbacks, "/agent");
		const call = tool.renderCall?.(
			{ action: "wait", name: "training", timeoutSeconds: 2.5 },
			identityTheme as never,
			{ argsComplete: true, cwd: "/workspace", toolCallId: "wait-render" } as never,
		);
		expect(renderedText(call)).toBe("session_job wait training (2.5s)");

		const result = {
			content: [{ type: "text" as const, text: "Wait timed out" }],
			details: {
				action: "wait" as const,
				job: {
					name: "training",
					command: "train",
					cwd: "/workspace",
					createdAt: "2026-07-22T00:00:00.000Z",
					pid: 123,
					status: "running" as const,
					logPath: "/callbacks/jobs/training/job.log",
				},
				waitTimedOut: true,
				waitedMs: 2_500,
			},
		};
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace", toolCallId: "wait-render", args: { action: "wait", name: "training" } } as never,
		);
		expect(renderedText(component)).toBe("training · running · pid 123 · wait timed out");
	});

	it("renders log output without repeating job metadata when collapsed", () => {
		const { callbacks } = createCallbackStream();
		const tool = createSessionJobTool(callbacks, "/agent");
		const result = {
			content: [{ type: "text" as const, text: "model-facing metadata and logs" }],
			details: {
				action: "logs" as const,
				job: {
					name: "training",
					command: "train",
					cwd: "/workspace",
					createdAt: "2026-07-22T00:00:00.000Z",
					pid: 123,
					status: "running" as const,
					logPath: "/callbacks/jobs/training/job.log",
				},
				logPath: "/callbacks/jobs/training/job.log",
				logText: "epoch 1/10\nepoch 2/10",
			},
		};

		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace", toolCallId: "logs-render", args: { action: "logs", name: "training" } } as never,
		);
		expect(renderedText(component)).toBe("epoch 1/10\nepoch 2/10");
	});

	it("runs a detached job, records logs, and emits progress and completion callbacks", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks, entries, messages } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "job-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);

		const startResult = await tool.execute(
			"start-job",
			{
				action: "start",
				name: "integration",
				command: 'printf "first\\n"; pi-callback --no-wake "halfway"; printf "last\\n"',
			},
			undefined,
			undefined,
			context,
		);
		expect(startResult.details?.job?.status).toBe("running");

		await waitFor(() => entries.length >= 1 && messages.length >= 1);
		expect(entries.some((entry) => (entry.data as { message?: string }).message === "halfway")).toBe(true);
		expect(messages[0]?.message.content).toBe("Job integration completed successfully.");
		expect(messages[0]?.options.triggerTurn).toBe(true);

		const statusResult = await tool.execute(
			"status-job",
			{ action: "status", name: "integration" },
			undefined,
			undefined,
			context,
		);
		expect(statusResult.details?.job?.status).toBe("succeeded");
		expect(statusResult.details?.job?.exitCode).toBe(0);

		const logPath = statusResult.details?.job?.logPath;
		expect(logPath).toBeDefined();
		if (!logPath) throw new Error("job did not return a log path");
		expect(await readFile(logPath, "utf8")).toContain("first\nlast\n");
		callbacks.stop();
	});

	it("stops a running process group", async () => {
		const agentDirectory = await createTemporaryDirectory();
		const workspace = await createTemporaryDirectory();
		const { callbacks } = createCallbackStream();
		const context = createContext(workspace);
		await callbacks.start(agentDirectory, "stop-session", context);
		const tool = createSessionJobTool(callbacks, agentDirectory);
		await tool.execute(
			"start-sleeper",
			{ action: "start", name: "sleeper", command: "sleep 30" },
			undefined,
			undefined,
			context,
		);

		const stopResult = await tool.execute(
			"stop-sleeper",
			{ action: "stop", name: "sleeper" },
			undefined,
			undefined,
			context,
		);

		expect(stopResult.details?.job?.status).toBe("stopped");
		callbacks.stop();
	});
});
