import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type CallbackStatusEntry, CallbackStream, type WakingCallbackDetails } from "./callbacks.js";
import { createSessionJobTool } from "./jobs.js";

export type SessionCallbacksOptions = {
	rescanIntervalMs?: number;
};

export function getAgentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function createSessionCallbacksExtension(options: SessionCallbacksOptions = {}) {
	return function sessionCallbacks(pi: ExtensionAPI): void {
		const agentDirectory = getAgentDirectory();
		const callbacks = new CallbackStream(pi, options);

		pi.registerMessageRenderer("session-callback", (message, { expanded }, theme) => {
			const details = message.details as WakingCallbackDetails | undefined;
			const visibleMessage = details?.wakingMessage ?? message.content;
			const source = expanded && details?.sourcePath ? `\n${theme.fg("dim", details.sourcePath)}` : "";
			return new Text(`${theme.fg("accent", theme.bold("Session callback"))}\n${visibleMessage}${source}`, 0, 0);
		});

		pi.registerEntryRenderer<CallbackStatusEntry>("session-callback-status", (entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data) return new Text(theme.fg("warning", "Session update unavailable"), 0, 0);
			const timestamp = expanded ? `\n${theme.fg("dim", data.timestamp)}` : "";
			return new Text(`${theme.fg("accent", theme.bold("Session update"))}\n${data.message}${timestamp}`, 0, 0);
		});

		pi.registerTool(createSessionJobTool(callbacks, agentDirectory));

		pi.on("session_start", async (_event, ctx) => {
			await callbacks.start(agentDirectory, ctx.sessionManager.getSessionId(), ctx);
			if (ctx.hasUI) ctx.ui.notify(`Callback inbox: ${path.join(callbacks.root ?? "", "inbox")}`, "info");
		});

		pi.on("session_shutdown", async () => {
			callbacks.stop();
		});

		pi.on("before_agent_start", (event) => {
			const prompt = callbacks.prompt();
			if (!prompt) return;
			return { systemPrompt: event.systemPrompt + prompt };
		});

		pi.registerCommand("callback-info", {
			description: "Show this session's callback inbox and durable job directory.",
			handler: async (_args, ctx) => {
				if (!callbacks.root) {
					ctx.ui.notify("Callback stream is not initialized.", "warning");
					return;
				}
				ctx.ui.notify(
					`Callback inbox: ${path.join(callbacks.root, "inbox")}\nJobs: ${path.join(callbacks.root, "jobs")}`,
					"info",
				);
			},
		});
	};
}

export default createSessionCallbacksExtension();

export { buildCallbackBootstrap, CallbackStream, parseCallbackFileName } from "./callbacks.js";
export { createSessionJobTool, type JobSnapshot, type JobStatus, validateJobName } from "./jobs.js";
