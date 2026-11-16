/**
 * pi-compact-model — run compaction and branch summaries on a different model.
 *
 * Pi's compaction normally summarizes with the model the conversation is using. With a
 * local model that single call can take minutes. This extension keeps Pi's own
 * compaction code path (`compact()` / `generateBranchSummary()` from pi-coding-agent:
 * same prompts, same structured summary, same file tracking, same retry policy) and
 * swaps only the model, thinking level, and request path of that summarization call.
 *
 * Everything else — the conversation, tools, `/model` selection — is untouched.
 *
 * Config files (project wins over global, key by key; `null` clears an inherited key):
 *   ~/.pi/agent/compact-model.json
 *   <cwd>/.pi/compact-model.json
 * Also read: PI_COMPACT_MODEL=<provider/modelId> and pi --compact-model <provider/modelId>.
 *
 * Command: /compact-model [pattern | status | clear | thinking <level> | branch on|off
 *                        | fallback on|off | guard on|off] [--project]
 */

import { existsSync } from "node:fs";
import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { compact, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_FLAG,
	DISABLE_VALUES,
	IGNORE_PROJECT_ENV_VAR,
	loadEffectiveConfig,
	projectConfigIgnored,
	writeConfigFile,
	type ConfigScope,
	type EffectiveConfig,
} from "./src/config.ts";
import { THINKING_LEVELS, formatModel, resolveModelReference } from "./src/model-ref.ts";
import { runBranchSummary } from "./src/branch.ts";
import { isSameModel, resolveCompactTarget, type TargetOutcome } from "./src/target.ts";
import { debug, debugError, errorText, shortError } from "./src/debug.ts";

const COMMAND = "compact-model";
/** Output tokens kept free when checking whether the summary input fits the compact model. */
const OUTPUT_RESERVE_TOKENS = 16384;
/** Rough size of the summarization instructions wrapped around the conversation. */
const PROMPT_OVERHEAD_TOKENS = 2048;
/** Pi's built-in defaults for settings.retry, mirrored so retries behave like Pi's own. */
const RETRY_DEFAULTS = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 };

function flagValue(pi: ExtensionAPI): string | undefined {
	const value = pi.getFlag(CONFIG_FLAG);
	return typeof value === "string" ? value : undefined;
}

/** Stream through Pi's configured provider stack, which resolves request-time auth itself. */
function streamFnFor(ctx: ExtensionContext): StreamFn {
	const registry = ctx.modelRegistry;
	return (model, context, options) =>
		registry.streamSimple(model, context as Parameters<typeof registry.streamSimple>[1], options as never) as ReturnType<
			typeof registry.streamSimple
		>;
}

function retryPolicy(pi: ExtensionAPI): RetryPolicy {
	const retry = pi.getSettings().retry;
	return {
		enabled: retry?.enabled ?? RETRY_DEFAULTS.enabled,
		maxRetries: retry?.maxRetries ?? RETRY_DEFAULTS.maxRetries,
		baseDelayMs: retry?.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs,
		maxAgentDelayMs: retry?.maxAgentDelayMs ?? RETRY_DEFAULTS.maxAgentDelayMs,
	};
}

function secondsSince(startedAt: number): string {
	return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function availableProviders(ctx: ExtensionContext): Set<string> {
	return new Set(ctx.modelRegistry.getAll().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)).map((model) => model.provider));
}

/** Summarization input size: what the compact model would have to read. */
function estimateSummaryInputTokens(preparation: {
	messagesToSummarize: readonly AgentMessage[];
	turnPrefixMessages: readonly AgentMessage[];
	previousSummary?: string;
}): number {
	let tokens = 0;
	for (const message of preparation.messagesToSummarize) tokens += estimateTokens(message);
	for (const message of preparation.turnPrefixMessages) tokens += estimateTokens(message);
	if (preparation.previousSummary) tokens += Math.ceil(preparation.previousSummary.length / 4);
	return tokens + PROMPT_OVERHEAD_TOKENS;
}

function compactModelInputLimit(model: Model<Api>): number {
	const output = Math.min(model.maxTokens || OUTPUT_RESERVE_TOKENS, OUTPUT_RESERVE_TOKENS);
	return Math.max(1024, model.contextWindow - output - PROMPT_OVERHEAD_TOKENS);
}

/** Report config problems and non-fatal resolution notes once per summarization. */
function reportOutcome(ctx: ExtensionContext, outcome: TargetOutcome, noteInactive = false): void {
	if (outcome.kind === "off") {
		if (noteInactive) {
			const message =
				outcome.config.model && !outcome.config.enabled
					? `compact model is off (${outcome.config.model}) — "/compact-model on" to enable`
					: "no compact model configured — compaction uses the session model";
			ctx.ui.notify(`pi-compact-model: ${message}`, "info");
		}
		return;
	}
	if (outcome.kind === "error") {
		ctx.ui.notify(`pi-compact-model: ${outcome.message}`, "warning");
		return;
	}
	for (const warning of outcome.target.warnings) ctx.ui.notify(`pi-compact-model: ${warning}`, "warning");
}

export default function (pi: ExtensionAPI): void {
	pi.registerFlag(CONFIG_FLAG, {
		type: "string",
		description: "Model used only for compaction and branch summaries, as provider/modelId",
	});

	pi.on("session_start", async (_event, ctx) => {
		reportOutcome(ctx, await resolveCompactTarget(ctx, flagValue(pi)), true);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (event.signal.aborted) return;
		const outcome = await resolveCompactTarget(ctx, flagValue(pi));
		debug("session_before_compact", event.reason, `willRetry=${event.willRetry}`, outcome.kind, outcome.kind === "target" ? formatModel(outcome.target.model) : "");
		reportOutcome(ctx, outcome);
		if (outcome.kind !== "target") return; // nothing configured, or unusable: let Pi summarize
		const { target } = outcome;
		if (isSameModel(target.model, ctx.model)) return; // identical model: use Pi's native path
		if (event.willRetry) {
			// Pi retries a failed compaction; do not spend the compact model twice per request.
			debug("retrying with the session model");
			return;
		}

		const inputTokens = estimateSummaryInputTokens(event.preparation);
		const limit = compactModelInputLimit(target.model);
		if (outcome.config.skipIfContextTooSmall && inputTokens > limit) {
			ctx.ui.notify(
				`pi-compact-model: ${formatModel(target.model)} cannot fit ${inputTokens.toLocaleString()} summary tokens (limit ${limit.toLocaleString()}); using the session model`,
				"warning",
			);
			return;
		}

		const thinking = target.thinkingLevel && target.thinkingLevel !== "off" ? ` (thinking: ${target.thinkingLevel})` : "";
		ctx.ui.notify(`Compacting with ${formatModel(target.model)}${thinking}…`, "info");
		const startedAt = Date.now();
		try {
			const result = await compact(
				event.preparation,
				target.model,
				undefined, // apiKey: the model runtime behind streamSimple resolves request-time auth
				undefined, // headers
				event.customInstructions,
				event.signal,
				target.thinkingLevel,
				streamFnFor(ctx),
				undefined, // env
				retryPolicy(pi),
				undefined, // retry callbacks: Pi owns the compaction UI
				undefined, // sessionId: a fresh routing id per summary, like Pi does
			);
			ctx.ui.notify(`Compacted with ${formatModel(target.model)} in ${secondsSince(startedAt)}`, "info");
			return { compaction: result };
		} catch (error) {
			debugError("compact() with the compact model failed", error);
			if (event.signal.aborted) return { cancel: true };
			const message = errorText(error);
			if (!outcome.config.fallbackToSessionModel) {
				ctx.ui.notify(`pi-compact-model: compaction failed (${message}); not retrying with the session model`, "error");
				return { cancel: true };
			}
			ctx.ui.notify(`pi-compact-model: ${formatModel(target.model)} failed (${message}); falling back to the session model`, "warning");
			return;
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		const preparation = event.preparation;
		if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return;

		const outcome = await resolveCompactTarget(ctx, flagValue(pi));
		if (outcome.kind !== "target" || !outcome.config.branchSummaries) return;
		const { target } = outcome;
		if (isSameModel(target.model, ctx.model)) return;

		const startedAt = Date.now();
		ctx.ui.notify(`Summarizing branch with ${formatModel(target.model)}…`, "info");
		const run = await runBranchSummary({
			entries: preparation.entriesToSummarize,
			model: target.model,
			signal: event.signal,
			thinkingLevel: target.thinkingLevel,
			customInstructions: preparation.customInstructions,
			replaceInstructions: preparation.replaceInstructions,
			reserveTokens: pi.getSettings().branchSummary?.reserveTokens ?? 16384,
			streamFn: streamFnFor(ctx),
			retry: retryPolicy(pi),
		});
		if (!run.ok) {
			if (event.signal.aborted) return { cancel: true };
			if (!outcome.config.fallbackToSessionModel) {
				ctx.ui.notify(`pi-compact-model: branch summary failed (${shortError(run.error)}); cancelling navigation`, "error");
				return { cancel: true };
			}
			ctx.ui.notify(`pi-compact-model: ${formatModel(target.model)} failed (${shortError(run.error)}); falling back to the session model`, "warning");
			return;
		}
		ctx.ui.notify(`Branch summarized with ${formatModel(target.model)} in ${secondsSince(startedAt)}`, "info");
		return { summary: run.summary };
	});

	pi.registerCommand(COMMAND, {
		description: "Show or set the model used only for compaction and branch summaries",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "on", "off", "clear", "thinking", "branch", "fallback", "guard", "--project"];
			const items = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const scope: ConfigScope = tokens.some((token) => token === "--project" || token === "-p") ? "project" : "global";
			const rest = tokens.filter((token) => token !== "--project" && token !== "-p");
			const sub = rest[0]?.toLowerCase();
			if (scope === "project" && projectConfigIgnored()) {
				ctx.ui.notify(`pi-compact-model: project config is ignored while ${IGNORE_PROJECT_ENV_VAR} is set — drop --project to write the global file`, "error");
				return;
			}

			if (sub === undefined) {
				notifyStatus(ctx, flagValue(pi));
				await pickModelInteractively(ctx, scope, flagValue(pi));
				return;
			}
			if (sub === "status") {
				notifyStatus(ctx, flagValue(pi));
				return;
			}
			if (sub === "on" || sub === "off") {
				const path = writeConfigFile(scope, ctx.cwd, { enabled: sub === "on" });
				const config = loadEffectiveConfig(ctx.cwd, flagValue(pi));
				const state = !config.enabled
					? `off — compaction uses the session model${config.model ? ` (model kept: ${config.model})` : ""}`
					: config.model
						? `on (${config.model})`
						: "on, but no compact model is configured yet";
				notify(ctx, `compact model: ${state}`, config.enabled && !config.model ? "warning" : "info", path);
				return;
			}
			if (["clear", "default", "reset", "inherit"].includes(sub)) {
				const path = writeConfigFile(scope, ctx.cwd, { model: null, provider: null });
				notify(ctx, `compaction will use the session model (${ctx.model ? formatModel(ctx.model) : "none"})`, "info", path);
				return;
			}
			if (sub === "thinking") {
				const level = rest[1]?.toLowerCase();
				if (!level) {
					ctx.ui.notify(`pi-compact-model: thinking accepts ${THINKING_LEVELS.join(" | ")} | inherit`, "info");
					return;
				}
				if (level !== "inherit" && !(THINKING_LEVELS as readonly string[]).includes(level)) {
					ctx.ui.notify(`pi-compact-model: unknown thinking level "${level}"`, "error");
					return;
				}
				const path = writeConfigFile(scope, ctx.cwd, { thinkingLevel: level === "inherit" ? null : (level as ThinkingLevel) });
				notify(ctx, `compaction thinking level: ${level}`, "info", path);
				return;
			}
			if (sub === "branch" || sub === "fallback" || sub === "guard") {
				const value = rest[1]?.toLowerCase();
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(`pi-compact-model: ${sub} expects "on" or "off"`, "error");
					return;
				}
				const key = sub === "branch" ? "branchSummaries" : sub === "fallback" ? "fallbackToSessionModel" : "skipIfContextTooSmall";
				const path = writeConfigFile(scope, ctx.cwd, { [key]: value === "on" });
				notify(ctx, `compaction ${sub}: ${value}`, "info", path);
				return;
			}
			await setCompactModel(ctx, rest.join(" "), scope, flagValue(pi));
		},
	});
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", savedTo?: string): void {
	ctx.ui.notify(savedTo ? `pi-compact-model: ${message} (saved to ${savedTo})` : `pi-compact-model: ${message}`, level);
}

function resolveLabel(config: EffectiveConfig, ctx: ExtensionContext): string {
	if (!config.model) return "none — using the session model";
	const available = availableProviders(ctx);
	const result = resolveModelReference(config.model, ctx.modelRegistry.getAll(), {
		provider: config.provider,
		isAvailable: (provider) => available.has(provider),
	});
	if (result.status === "resolved") return `${formatModel(result.model)} (from ${config.modelSource ?? "config"})`;
	return `${config.model} — not resolved from ${config.modelSource ?? "config"} (${result.status})`;
}

function notifyStatus(ctx: ExtensionContext, flag: string | undefined): void {
	const config = loadEffectiveConfig(ctx.cwd, flag);
	const model = config.enabled
		? resolveLabel(config, ctx)
		: `off — kept ${config.model ?? "none"} (${config.enabledSource ?? "default"}); "/compact-model on" to enable`;
	const lines = [
		`compact model: ${model}`,
		`session model: ${ctx.model ? formatModel(ctx.model) : "none"}   thinking: ${config.thinkingLevel}`,
		`branch summaries: ${config.branchSummaries ? "on" : "off"}   fallback: ${config.fallbackToSessionModel ? "on" : "off"}   context guard: ${config.skipIfContextTooSmall ? "on" : "off"}`,
		`config: ${describeConfigFiles(config.configPaths)}`,
		...config.warnings.map((warning) => `warning: ${warning}`),
	];
	ctx.ui.notify(lines.join("\n"), config.warnings.length > 0 ? "warning" : "info");
}

/** Show only config files that exist, marking the one that wins key by key. */
function describeConfigFiles(paths: string[]): string {
	const found = paths
		.map((path, index) => ({ path, scope: index === 0 ? "global" : "project", exists: path !== "" && existsSync(path) }))
		.filter((entry) => entry.exists);
	if (found.length === 0) return "no compact-model.json yet — \"/compact-model <model>\" creates one";
	return found.map((entry) => `${entry.path} (${entry.scope}${entry.scope === "project" ? ", wins key by key" : ""})`).join(", ");
}

async function setCompactModel(ctx: ExtensionContext, reference: string, scope: ConfigScope, flag: string | undefined): Promise<void> {
	const available = availableProviders(ctx);
	const result = resolveModelReference(reference, ctx.modelRegistry.getAll(), { isAvailable: (provider) => available.has(provider) });
	if (result.status === "resolved") {
		await saveCompactModel(ctx, result.model, scope, flag, result.thinkingLevel, result.warning);
		return;
	}
	if (result.status === "not-found") {
		const suggestions = result.suggestions.slice(0, 6).map(formatModel);
		ctx.ui.notify(
			`pi-compact-model: no model matches "${reference}"${suggestions.length > 0 ? `. Try: ${suggestions.join(", ")}` : ". Run /compact-model to browse."}`,
			"error",
		);
		return;
	}
	const chosen = await selectModel(ctx, result.candidates, `"${reference}" matches ${result.candidates.length}`);
	if (!chosen) {
		ctx.ui.notify(`pi-compact-model: ambiguous "${reference}": ${result.candidates.slice(0, 8).map(formatModel).join(", ")}`, "info");
		return;
	}
	await saveCompactModel(ctx, chosen, scope, flag, result.thinkingLevel);
}

/**
 * Save the chosen model, then ask for the compaction thinking level the way `/model`
 * does for reasoning models ("inherit" keeps the session level).
 */
async function saveCompactModel(
	ctx: ExtensionContext,
	model: Model<Api>,
	scope: ConfigScope,
	flag: string | undefined,
	thinkingLevel?: ThinkingLevel,
	warning?: string,
): Promise<void> {
	const wasOff = !loadEffectiveConfig(ctx.cwd, flag).enabled;
	let path = writeConfigFile(scope, ctx.cwd, { enabled: true, model: formatModel(model), provider: null });
	notify(ctx, `compact model set to ${formatModel(model)}${wasOff ? " — compaction model is on" : ""}`, "info", path);
	if (warning) ctx.ui.notify(`pi-compact-model: ${warning}`, "warning");

	if (!model.reasoning) {
		if (thinkingLevel) {
			path = writeConfigFile(scope, ctx.cwd, { thinkingLevel });
			notify(ctx, `compaction thinking level: ${thinkingLevel}`, "info", path);
		}
		return;
	}
	const levels = ["inherit (session level)", ...THINKING_LEVELS];
	const choice = await ctx.ui.select(`Thinking level for ${formatModel(model)} during compaction`, levels);
	if (choice === undefined) return;
	const level = choice.startsWith("inherit") ? null : (choice as ThinkingLevel);
	path = writeConfigFile(scope, ctx.cwd, { thinkingLevel: level });
	notify(ctx, `compaction thinking level: ${level ?? "inherit (session level)"}`, "info", path);
}

function modelLabel(model: Model<Api>, ctx: ExtensionContext, current?: Model<Api>): string {
	const mark = current && isSameModel(model, current) ? "✓ " : "";
	const auth = ctx.modelRegistry.hasConfiguredAuth(model) ? "" : " [no credentials]";
	const window = model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1000)}k` : String(model.contextWindow);
	return `${mark}${formatModel(model)}  ${window}${auth}`;
}

async function selectModel(ctx: ExtensionContext, candidates: Model<Api>[], title: string, current?: Model<Api>): Promise<Model<Api> | undefined> {
	if (!ctx.hasUI) return undefined;
	const labels = candidates.map((model) => modelLabel(model, ctx, current));
	const choice = await ctx.ui.select(`Compact model — ${title}`, labels);
	if (choice === undefined) return undefined;
	const index = labels.indexOf(choice);
	return index >= 0 ? candidates[index] : undefined;
}

/** `/compact-model` with no argument: status, then a search loop like `/model`. */
async function pickModelInteractively(ctx: ExtensionContext, scope: ConfigScope, flag: string | undefined): Promise<void> {
	if (!ctx.hasUI) return;
	const current = await resolveCompactTarget(ctx, flag);
	const configured = current.kind === "target" ? current.target.model : ctx.model;
	const all = ctx.modelRegistry.getAll();
	const available = availableProviders(ctx);
	for (;;) {
		const query = await ctx.ui.input(
			configured
				? `Compact model? type to search, Enter keeps ${formatModel(configured)}, "off" disables, "clear" uses the session model`
				: "Compact model? type to search, Enter keeps the session model",
			"e.g. haiku, gemini-flash, openrouter/claude",
		);
		if (query === undefined || query.trim() === "") return;
		const trimmed = query.trim();
		if (trimmed.toLowerCase() === "off" || trimmed.toLowerCase() === "disable") {
			const path = writeConfigFile(scope, ctx.cwd, { enabled: false });
			notify(ctx, "compact model: off — compaction uses the session model", "info", path);
			return;
		}
		if (DISABLE_VALUES.has(trimmed.toLowerCase())) {
			const path = writeConfigFile(scope, ctx.cwd, { model: null, provider: null });
			notify(ctx, "compaction will use the session model", "info", path);
			return;
		}
		const result = resolveModelReference(trimmed, all, { isAvailable: (provider) => available.has(provider) });
		if (result.status === "not-found") {
			const suggestions = result.suggestions.slice(0, 4).map(formatModel);
			ctx.ui.notify(`pi-compact-model: no model matches "${trimmed}"${suggestions.length > 0 ? `. Try: ${suggestions.join(", ")}` : ""}`, "warning");
			continue;
		}
		const chosen =
			result.status === "resolved"
				? result.model
				: await selectModel(ctx, result.candidates, `"${trimmed}" matches ${result.candidates.length}`, configured);
		if (!chosen) return;
		await saveCompactModel(ctx, chosen, scope, flag, result.thinkingLevel);
		return;
	}
}
