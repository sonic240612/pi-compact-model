import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelReference, splitThinkingLevel, splitProvider, suggestModels } from "../src/model-ref.ts";

interface ModelSeed {
	provider: string;
	id: string;
	name?: string;
}

function model(seed: ModelSeed): Model<Api> {
	return {
		id: seed.id,
		name: seed.name ?? seed.id,
		api: "openai-completions" as Api,
		provider: seed.provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_000,
		type: "chat",
	} as Model<Api>;
}

const CATALOG: Model<Api>[] = [
	model({ provider: "openrouter", id: "qwen/qwen3.8-27b:free", name: "Qwen3.8 27B (free)" }),
	model({ provider: "openrouter", id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" }),
	model({ provider: "anthropic", id: "claude-haiku-4.5", name: "Claude Haiku 4.5" }),
	model({ provider: "openrouter", id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" }),
	model({ provider: "llama.cpp", id: "qwen3-coder:latest", name: "Qwen3 Coder" }),
	model({ provider: "openrouter", id: "qwen/qwen3-coder:exacto", name: "Qwen3 Coder Exacto" }),
model({ provider: "github-copilot", id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (Copilot)" }),
];

const noCredentials = () => false;
const onlyLocal = (provider: string) => provider === "llama.cpp";

test("exact provider/id match wins", () => {
	const result = resolveModelReference("openrouter/anthropic/claude-haiku-4.5", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.id, "anthropic/claude-haiku-4.5");
});

test("openrouter ids keep their inner slashes and colon suffixes", () => {
	const result = resolveModelReference("openrouter/qwen/qwen3.8-27b:free", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.id, "qwen/qwen3.8-27b:free");
	assert.equal(result.thinkingLevel, undefined);
});

test("provider-less exact id resolves when unique", () => {
	const result = resolveModelReference("google/gemini-2.5-flash", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.provider, "openrouter");
});

test("provider-less exact id with several providers is ambiguous", () => {
	const result = resolveModelReference("claude-haiku-4.5", CATALOG);
	assert.equal(result.status, "ambiguous");
	if (result.status === "ambiguous") {
		assert.deepEqual(
			result.candidates.map((candidate) => `${candidate.provider}/${candidate.id}`).sort(),
			["anthropic/claude-haiku-4.5", "github-copilot/claude-haiku-4.5", "openrouter/anthropic/claude-haiku-4.5"],
		);
	}
});

test("a bare id collision resolves to the only credentialed provider", () => {
	const withoutCredentials = resolveModelReference("claude-haiku-4.5", CATALOG, { isAvailable: noCredentials });
	assert.equal(withoutCredentials.status, "ambiguous");
	const result = resolveModelReference("claude-haiku-4.5", CATALOG, { isAvailable: (provider) => provider === "anthropic" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.provider, "anthropic");
		assert.match(result.warning ?? "", /credentials/);
	}
});

test("thinking suffix is parsed only when the whole text does not match", () => {
	const withSuffix = resolveModelReference("openrouter/google/gemini-2.5-flash:high", CATALOG);
	assert.equal(withSuffix.status, "resolved");
	if (withSuffix.status === "resolved") {
		assert.equal(withSuffix.model.id, "google/gemini-2.5-flash");
		assert.equal(withSuffix.thinkingLevel, "high");
	}
	const kept = resolveModelReference("llama.cpp/qwen3-coder:latest", CATALOG);
	assert.equal(kept.status, "resolved");
	if (kept.status === "resolved") assert.equal(kept.model.id, "qwen3-coder:latest");
});

test("non-thinking colon suffix is not stripped from a real id", () => {
	const result = resolveModelReference("openrouter/qwen/qwen3-coder:exacto:low", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "qwen/qwen3-coder:exacto");
		assert.equal(result.thinkingLevel, "low");
	}
});

test("fuzzy id substring resolves when unique", () => {
	const result = resolveModelReference("gemini", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "google/gemini-2.5-flash");
		assert.match(result.warning ?? "", /fuzzy/);
	}
});

test("fuzzy name substring resolves when unique", () => {
	const result = resolveModelReference("Exacto", CATALOG);
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.id, "qwen/qwen3-coder:exacto");
});

test("ambiguous fuzzy matches prefer the credentialed provider", () => {
	const result = resolveModelReference("coder", CATALOG, { isAvailable: onlyLocal });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.provider, "llama.cpp");
		assert.match(result.warning ?? "", /credentials/);
	}
	const unranked = resolveModelReference("coder", CATALOG, { isAvailable: noCredentials });
	assert.equal(unranked.status, "ambiguous");
	if (unranked.status === "ambiguous") assert.ok(unranked.candidates.length >= 2);
});

test("provider hint restricts fuzzy matching", () => {
	const result = resolveModelReference("haiku", CATALOG, { provider: "anthropic" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.provider, "anthropic");
});

test("unknown references report suggestions instead of failing silently", () => {
	const result = resolveModelReference("haiku-not-real", CATALOG, { isAvailable: noCredentials });
	assert.equal(result.status, "not-found");
	if (result.status === "not-found") assert.ok(result.suggestions.length > 0);
});

test("splitThinkingLevel and splitProvider keep odd ids intact", () => {
	assert.deepEqual(splitThinkingLevel("qwen/qwen3.8-27b:free"), { text: "qwen/qwen3.8-27b:free" });
	assert.deepEqual(splitThinkingLevel("openrouter/gpt-5:off"), { text: "openrouter/gpt-5", thinkingLevel: "off" });
	assert.deepEqual(splitProvider("openrouter/qwen/qwen3.8-27b:free"), { provider: "openrouter", id: "qwen/qwen3.8-27b:free" });
	assert.deepEqual(splitProvider("qwen3-coder:latest"), { id: "qwen3-coder:latest" });
});

test("suggestModels prefers credentialed providers", () => {
	const suggestions = suggestModels("haiku", CATALOG, (provider) => provider === "anthropic");
	assert.equal(suggestions[0]?.provider, "anthropic");
});
