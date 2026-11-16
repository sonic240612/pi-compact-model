import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runBranchSummary } from "../src/branch.ts";

const MODEL = {
	id: "summarizer",
	name: "Mock Summarizer",
	api: "openai-completions" as Api,
	provider: "mock",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4000,
} as Model<Api>;

const RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 };
const STREAM_FN = () => {
	throw new Error("the stub summarizer must not call the real stream function");
};

interface SeenOptions {
	model: Model<Api>;
	thinkingLevel?: string;
	reserveTokens?: number;
	customInstructions?: string;
	replaceInstructions?: boolean;
	retry?: unknown;
	streamFn?: unknown;
}

function base(overrides: Record<string, unknown> = {}) {
	return {
		entries: [],
		model: MODEL,
		signal: new AbortController().signal,
		reserveTokens: 1024,
		streamFn: STREAM_FN as never,
		retry: RETRY,
		...overrides,
	} as never;
}

test("passes the compact model and options through to Pi's branch summarization", async () => {
	const seen: SeenOptions[] = [];
	const result = await runBranchSummary(
		base({
			thinkingLevel: "low",
			customInstructions: "focus on decisions",
			replaceInstructions: true,
			summarize: async (_entries: unknown, options: SeenOptions) => {
				seen.push(options);
				return { summary: "## Goal\nSummarized by the compact model.", readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] };
			},
		}),
	);

	assert.ok(result.ok);
	assert.equal(result.summary.summary, "## Goal\nSummarized by the compact model.");
	assert.deepEqual(result.summary.details, { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });

	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.model, MODEL, "the compact model must be the model that summarizes");
	assert.equal(seen[0]?.thinkingLevel, "low");
	assert.equal(seen[0]?.reserveTokens, 1024);
	assert.equal(seen[0]?.customInstructions, "focus on decisions");
	assert.equal(seen[0]?.replaceInstructions, true);
	assert.equal(seen[0]?.retry, RETRY);
	assert.equal(seen[0]?.streamFn, STREAM_FN);
});

test("a model that returns no summary is reported as a failure", async () => {
	const result = await runBranchSummary(
		base({
			summarize: async () => ({ summary: undefined, error: "429: rate limited" }),
		}),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "429: rate limited");
});

test("a throwing summarizer never propagates", async () => {
	const result = await runBranchSummary(
		base({
			summarize: async () => {
				throw new Error("connection reset");
			},
		}),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "connection reset");
});

test("aborted runs report as aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await runBranchSummary(
		base({
			signal: controller.signal,
			summarize: async () => ({ summary: "late" }),
		}),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "aborted");
});

test("multi-line provider errors are flattened", async () => {
	const result = await runBranchSummary(
		base({
			summarize: async () => {
				throw new Error('403: {"message":"Key limit exceeded",\n "code":403}');
			},
		}),
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.error, /^403: \{"message":"Key limit exceeded", "code":403\}$/);
		assert.ok(result.error.length < 200);
	}
});
