import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallbackBootstrap, CallbackStream, parseCallbackFileName } from "../src/callbacks.js";
import { createSessionJobTool, validateJobName } from "../src/jobs.js";

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
	it("validates portable explicit names", () => {
		expect(validateJobName("tests-linux_1.0")).toBe(true);
		expect(validateJobName("-bad")).toBe(false);
		expect(validateJobName("has spaces")).toBe(false);
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
