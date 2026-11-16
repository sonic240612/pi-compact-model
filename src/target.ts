/**
 * Resolve the model that should run compaction/branch summaries for this session.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, modelsAreEqual } from "@earendil-works/pi-ai/models";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadEffectiveConfig, type EffectiveConfig } from "./config.ts";
import { formatModel, resolveModelReference } from "./model-ref.ts";

export interface CompactTarget {
	/** Model reference text from config, flag, or environment. */
	reference: string;
	/** Where the reference came from (config path, PI_COMPACT_MODEL, or --compact-model). */
	source: string;
	/** Resolved catalogue model, unchanged: the model runtime applies base URLs and auth. */
	model: Model<Api>;
	/** Thinking level for the summarization call, already clamped to the model. */
	thinkingLevel?: ThinkingLevel;
	/** Non-fatal notes worth showing once (fuzzy matches, provider ties). */
	warnings: string[];
}

export type TargetOutcome =
	| { kind: "off"; config: EffectiveConfig }
	| { kind: "error"; message: string; config: EffectiveConfig }
	| { kind: "target"; target: CompactTarget; config: EffectiveConfig };

/** Provider ids whose models have usable credentials, for tie-breaking like Pi does. */
function availabilityOf(ctx: ExtensionContext): (provider: string) => boolean {
	const configured = new Set(
		ctx.modelRegistry
			.getAll()
			.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
			.map((model) => model.provider),
	);
	return (provider) => configured.has(provider);
}

export async function resolveCompactTarget(ctx: ExtensionContext, flagValue?: string): Promise<TargetOutcome> {
	const config = loadEffectiveConfig(ctx.cwd, flagValue);
	if (!config.enabled || !config.model) return { kind: "off", config };

	const all = ctx.modelRegistry.getAll();
	const available = availabilityOf(ctx);
	const result = resolveModelReference(config.model, all, { provider: config.provider, isAvailable: available });

	if (result.status === "not-found") {
		const suggestions = result.suggestions.slice(0, 6).map(formatModel);
		return {
			kind: "error",
			config,
			message:
				`No model matches "${config.model}" (${config.modelSource ?? "config"}).` +
				(suggestions.length > 0 ? ` Try one of: ${suggestions.join(", ")}.` : " Run /compact-model to browse models."),
		};
	}
	if (result.status === "ambiguous") {
		const candidates = result.candidates.slice(0, 6).map(formatModel);
		return {
			kind: "error",
			config,
			message: `"${config.model}" is ambiguous (${candidates.join(", ")}). Use the full provider/modelId.`,
		};
	}

	const model = result.model;
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return {
			kind: "error",
			config,
			message: `No credentials configured for ${formatModel(model)}. Run /login ${model.provider} or choose another compact model.`,
		};
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { kind: "error", config, message: `Authentication failed for ${formatModel(model)}: ${auth.error}` };
	}

	const requested = result.thinkingLevel ?? (config.thinkingLevel && config.thinkingLevel !== "inherit" ? config.thinkingLevel : ctx.thinkingLevel);
	// Keep the catalogue model unchanged: the ModelRuntime behind modelRegistry.streamSimple
	// resolves provider base URLs and credentials at request time (Pi does the same).
	const target: CompactTarget = {
		reference: config.model,
		source: config.modelSource ?? "config",
		model,
		thinkingLevel: requested ? clampThinkingLevel(model, requested) : undefined,
		warnings: [...config.warnings, ...(result.warning ? [result.warning] : [])],
	};
	return { kind: "target", target, config };
}

/** True when the compact model is the model the session already uses. */
export function isSameModel(a: Model<Api>, b: Model<Api> | undefined): boolean {
	return modelsAreEqual(a, b);
}
