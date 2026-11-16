/**
 * Test fixture: a zero-cost mock provider so the compaction path can be driven end to end
 * without any network calls. Every request is appended to MOCK_CALL_LOG as JSON, which is
 * how the assertions check which model actually performed the summarization.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const CALL_LOG = process.env.MOCK_CALL_LOG ?? "";
const FAIL_SUMMARIZER = process.env.MOCK_FAIL_SUMMARIZER === "1";

const FILLER = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ";

function reply(model: { id: string }, context: { messages: unknown[] }): string {
	if (model.id === "summarizer") {
		return [
			"## Goal",
			"Mock summary of the conversation.",
			"## Constraints",
			"- none",
			"## Progress",
			"- Done: mock chat turns.",
			"## Key decisions",
			"- Use the mock summarizer model.",
			"## Next steps",
			"- Finish the test.",
			"## Critical context",
			"- The summary call must be attributed to mock/summarizer.",
		].join("\n");
	}
	return `Mock chat answer about message ${context.messages.length}. ${FILLER.repeat(60)}`;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("mock", {
		name: "Mock",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			{ id: "chat", name: "Mock Chat", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 },
			{ id: "summarizer", name: "Mock Summarizer", api: "openai-completions", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 },
		],
		streamSimple: (model, context) => {
			const messages = (context as { messages?: unknown[] }).messages ?? [];
			if (CALL_LOG) {
				appendFileSync(
					CALL_LOG,
					`${JSON.stringify({ model: `${model.provider}/${model.id}`, api: model.api, messages: messages.length, contextWindow: model.contextWindow })}\n`,
				);
			}
			const stream = createAssistantMessageEventStream();
			const failed = model.id === "summarizer" && FAIL_SUMMARIZER;
			const text = failed ? "" : reply(model, { messages });
			const message = {
				role: "assistant" as const,
				content: text ? [{ type: "text" as const, text }] : [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: messages.length * 10,
					output: text.length >> 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: messages.length * 10 + (text.length >> 2),
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: failed ? ("error" as const) : ("stop" as const),
				errorMessage: failed ? "mock summarizer failure" : undefined,
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message } as never);
			if (text) stream.push({ type: "text", contentIndex: 0, delta: text } as never);
			if (failed) stream.push({ type: "error", error: message } as never);
			else stream.push({ type: "done", reason: "stop", message } as never);
			return stream;
		},
	});
}
