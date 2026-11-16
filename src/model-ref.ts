/**
 * Pi-style model reference parsing and matching.
 *
 * Mirrors pi's `ModelRegistry.find` plus `resolveCliModel`/`ModelSelector` behaviour so a
 * compact model can be written the same way a model is picked in the `/model` UI or on the
 * pi CLI:
 *   - `openrouter/anthropic/claude-haiku-4.5` -> exact provider + exact id
 *   - `anthropic/claude-haiku-4.5`            -> exact id, any provider (provider hint wins)
 *   - `haiku`                                 -> case-insensitive substring of id or name
 *   - `<reference>:<thinkingLevel>`           -> thinking level suffix, when the full text
 *                                                does not already match a model id
 *                                                (OpenRouter ids may end in `:free`)
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelMatchOptions {
	/** Preferred provider for provider-less references and ambiguous matches. */
	provider?: string;
	/** Provider has configured credentials; used to rank candidates like Pi does. */
	isAvailable?: (provider: string) => boolean;
}

export type ModelMatch =
	| { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel; warning?: string }
	| { status: "ambiguous"; candidates: Model<Api>[]; thinkingLevel?: ThinkingLevel }
	| { status: "not-found"; suggestions: Model<Api>[] };

const isReasoningLevel = (value: string): value is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(value);

/** Split a trailing `:thinkingLevel`, leaving ids such as `qwen3-coder:latest` alone. */
export function splitThinkingLevel(text: string): { text: string; thinkingLevel?: ThinkingLevel } {
	const index = text.lastIndexOf(":");
	if (index <= 0 || index === text.length - 1) return { text };
	const suffix = text.slice(index + 1).toLowerCase();
	if (!isReasoningLevel(suffix)) return { text };
	return { text: text.slice(0, index), thinkingLevel: suffix };
}

/** Split an optional leading `provider/`; OpenRouter ids keep their remaining slashes. */
export function splitProvider(reference: string): { provider?: string; id: string } {
	const slash = reference.indexOf("/");
	if (slash <= 0) return { id: reference };
	return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
}

export function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Candidate order: provider hint, credentialed providers, shorter ids (Pi's ranking shape). */
function rank(reference: string, options: ModelMatchOptions, models: Model<Api>[]): Model<Api>[] {
	const hint = options.provider?.toLowerCase();
	const needle = reference.toLowerCase();
	return models
		.filter((model) => (hint ? model.provider.toLowerCase() === hint : true))
		.sort((a, b) => {
			const aExact = a.id.toLowerCase() === needle ? 0 : 1;
			const bExact = b.id.toLowerCase() === needle ? 0 : 1;
			if (aExact !== bExact) return aExact - bExact;
			const aProviderMatch = hint && a.provider.toLowerCase() === hint ? 0 : 1;
			const bProviderMatch = hint && b.provider.toLowerCase() === hint ? 0 : 1;
			if (aProviderMatch !== bProviderMatch) return aProviderMatch - bProviderMatch;
			const aAvailable = options.isAvailable?.(a.provider) ? 0 : 1;
			const bAvailable = options.isAvailable?.(b.provider) ? 0 : 1;
			if (aAvailable !== bAvailable) return aAvailable - bAvailable;
			return a.id.length - b.id.length;
		});
}

/** Suggestions for an unknown reference, ordered like Pi's CLI fuzzy ranking. */
export function suggestModels(reference: string, models: Model<Api>[], isAvailable?: (provider: string) => boolean): Model<Api>[] {
	const ranked = rank(reference, { isAvailable }, fuzzy(models, reference));
	if (ranked.length > 0) return ranked;
	return rank(reference, { isAvailable }, models).slice(0, 12);
}

function fuzzy(models: Model<Api>[], reference: string): Model<Api>[] {
	const needle = reference.toLowerCase();
	const matches: Model<Api>[] = [];
	for (const model of models) {
		const id = model.id.toLowerCase();
		if (id.includes(needle) || (model.name ?? "").toLowerCase().includes(needle) || model.provider.toLowerCase().includes(needle)) {
			matches.push(model);
		}
	}
	return matches;
}

function single(candidates: Model<Api>[]): Model<Api> | undefined {
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Resolve a reference against the full catalogue. `isAvailable` mirrors Pi's
 * `modelRegistry.hasConfiguredAuth`: ambiguous provider matches collapse to the single
 * provider that actually has credentials.
 */
export function resolveModelReference(reference: string, models: Model<Api>[], options: ModelMatchOptions = {}): ModelMatch {
	const raw = reference.trim();
	const withoutThinking = splitThinkingLevel(raw);
	const exact = models.filter((model) => `${model.provider}/${model.id}` === raw || model.id === raw);
	const exactOnly = single(rank(raw, options, exact));
	if (exactOnly) return { status: "resolved", model: exactOnly, thinkingLevel: withoutThinking.thinkingLevel };

	// The full text is not a model id, so a trailing `:off`/`:low`/... is a thinking level.
	const { provider, id } = splitProvider(withoutThinking.text);
	const scoped = options.provider ? { provider: options.provider, ...options } : provider ? { provider, ...options } : options;

	const idExact = single(rank(id, scoped, models.filter((model) => model.id.toLowerCase() === id.toLowerCase())));
	if (idExact) return { status: "resolved", model: idExact, thinkingLevel: withoutThinking.thinkingLevel };

	const fuzzyMatches = fuzzy(models, id);
	if (fuzzyMatches.length === 0) {
		return { status: "not-found", suggestions: suggestModels(id, models, options.isAvailable) };
	}
	if (fuzzyMatches.length === 1) {
		const model = fuzzyMatches[0] as Model<Api>;
		return {
			status: "resolved",
			model,
			thinkingLevel: withoutThinking.thinkingLevel,
			warning: `fuzzy match: "${raw}" matched ${formatModel(model)}`,
		};
	}

	const ranked = rank(id, scoped, fuzzyMatches);
	const credentialed = options.isAvailable ? ranked.filter((model) => options.isAvailable?.(model.provider)) : ranked;
	const usable = single(credentialed);
	if (usable) {
		return {
			status: "resolved",
			model: usable,
			thinkingLevel: withoutThinking.thinkingLevel,
			warning: `${formatModel(usable)} is the only match with configured credentials among ${fuzzyMatches.length}`,
		};
	}
	return { status: "ambiguous", candidates: ranked, thinkingLevel: withoutThinking.thinkingLevel };
}
