/**
 * Config reading and merging, without any Pi imports so it can be unit tested.
 * `src/config.ts` supplies the real Pi paths.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const CONFIG_FILE_NAME = "compact-model.json";
export const CONFIG_ENV_VAR = "PI_COMPACT_MODEL";
export const CONFIG_FLAG = "compact-model";

export type ConfigScope = "global" | "project";
export const KNOWN_KEYS = [
	"enabled",
	"model",
	"provider",
	"thinkingLevel",
	"branchSummaries",
	"fallbackToSessionModel",
	"skipIfContextTooSmall",
] as const;

/** Values that mean "no compact model; compaction uses the session model". */
export const DISABLE_VALUES = new Set(["off", "none", "default", "inherit", "clear", "session", "same"]);

/** Raw config file shape. Every key is optional; `null` clears an inherited key. */
export interface CompactModelConfigFile {
	/** Master switch. `false` keeps the model configured but makes compaction use the session model. */
	enabled?: boolean | null;
	/** Model reference: `provider/modelId`, bare model id, or a fuzzy substring. */
	model?: string | null;
	/** Optional provider hint when `model` has no `provider/` prefix. */
	provider?: string | null;
	/** Thinking level for the summarization call. `"inherit"` uses the session level. */
	thinkingLevel?: ThinkingLevel | "inherit" | null;
	/** Also summarize abandoned branches (`/tree`) with the compact model. Default true. */
	branchSummaries?: boolean | null;
	/** Fall back to the session model when the compact model call fails. Default true. */
	fallbackToSessionModel?: boolean | null;
	/** Skip the compact model when the summary input cannot fit its context window. Default true. */
	skipIfContextTooSmall?: boolean | null;
}

/** Effective config after merging files, environment, and CLI flag. */
export interface EffectiveConfig {
	/** Whether the compact model should be used at all (`/compact-model on|off`). */
	enabled: boolean;
	/** Model reference to resolve, or undefined when the extension is inert. */
	model?: string;
	/** Provider hint for references without a `provider/` prefix. */
	provider?: string;
	thinkingLevel: ThinkingLevel | "inherit";
	branchSummaries: boolean;
	fallbackToSessionModel: boolean;
	skipIfContextTooSmall: boolean;
	/** Where the effective `model` value came from (file path, env var, or flag). */
	modelSource?: string;
	configPaths: string[];
	/** Where the effective `enabled` value came from (a config file path, flag, or env var). */
	enabledSource?: string;
	/** Problems found while reading the files. */
	warnings: string[];
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one config file. Missing or unreadable files count as empty. */
export function parseConfigFile(raw: string, path: string): { config: CompactModelConfigFile; warnings: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		return { config: {}, warnings: [`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`] };
	}
	if (!isRecord(parsed)) return { config: {}, warnings: [`${path}: expected a JSON object`] };

	const config: CompactModelConfigFile = {};
	const warnings: string[] = [];
	for (const key of ["model", "provider"] as const) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (value === null || typeof value === "string") config[key] = value;
		else warnings.push(`${path}: "${key}" must be a string or null`);
	}
	const thinking = parsed.thinkingLevel;
	if (thinking !== undefined) {
		if (thinking === null || thinking === "inherit") config.thinkingLevel = thinking;
		else if (typeof thinking === "string" && THINKING_LEVELS.has(thinking)) config.thinkingLevel = thinking as ThinkingLevel;
		else warnings.push(`${path}: "thinkingLevel" must be off|minimal|low|medium|high|xhigh|max|"inherit" or null`);
	}
	for (const key of ["enabled", "branchSummaries", "fallbackToSessionModel", "skipIfContextTooSmall"] as const) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (value === null || typeof value === "boolean") config[key] = value;
		else warnings.push(`${path}: "${key}" must be a boolean or null`);
	}
	for (const key of Object.keys(parsed)) {
		if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) warnings.push(`${path}: unknown setting "${key}"`);
	}
	return { config, warnings };
}

export function readConfigFile(path: string): { config: CompactModelConfigFile; warnings: string[] } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { config: {}, warnings: [] };
	}
	return parseConfigFile(raw, path);
}

/**
 * Value of a key in the highest-precedence layer that mentions it (later layers win).
 * A `null` in that layer clears the key, which is how a project opts out of a global setting.
 */
function pickLayer(layers: readonly CompactModelConfigFile[], key: keyof CompactModelConfigFile): { value: unknown; layer: number } | undefined {
	for (let index = layers.length - 1; index >= 0; index--) {
		const layer = layers[index];
		if (layer && Object.hasOwn(layer, key)) return { value: (layer as Record<string, unknown>)[key], layer: index };
	}
	return undefined;
}

function resolveKey<T>(layers: readonly CompactModelConfigFile[], key: keyof CompactModelConfigFile, fallback: T | undefined): T | undefined {
	const found = pickLayer(layers, key);
	if (!found || found.value === null) return fallback;
	return found.value as T;
}

export interface MergeInput {
	/** Parsed file layers in precedence order: [global, project]. */
	layers: readonly CompactModelConfigFile[];
	configPaths: string[];
	environment?: string;
	flag?: string;
	warnings?: string[];
	/** Ignore the project layer entirely (`PI_COMPACT_MODEL_NO_PROJECT=1`). */
	ignoreProjectLayer?: boolean;
}

/** Truthy environment flag values. */
export function envFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

/**
 * Merge global then project config, then PI_COMPACT_MODEL, then --compact-model.
 * A key present (including `null`) in the project layer overrides the global layer,
 * which is how a project opts back out of a global compact model.
 */
export function mergeConfigs(input: MergeInput): EffectiveConfig {
	const layers = input.ignoreProjectLayer ? input.layers.slice(0, 1) : input.layers;
	const configPaths = input.ignoreProjectLayer ? input.configPaths.slice(0, 1) : input.configPaths;
	const warnings = [...(input.warnings ?? [])];

	let model = resolveKey<string>(layers, "model", undefined);
	const modelLayer = pickLayer(layers, "model");
	let modelSource = model !== undefined && modelLayer ? configPaths[modelLayer.layer] : undefined;
	if (input.flag !== undefined) {
		model = input.flag;
		modelSource = `--${CONFIG_FLAG}`;
	} else if (input.environment) {
		model = input.environment;
		modelSource = CONFIG_ENV_VAR;
	}

	model = model?.trim();
	if (!model || DISABLE_VALUES.has(model.toLowerCase())) model = undefined;

	// `enabled` is a switch that survives independently of the model, so `/compact-model off`
	// keeps the configured model and `/compact-model on` brings it back.
	const enabledLayer = pickLayer(layers, "enabled");
	const fromCommandLine = input.flag !== undefined || Boolean(input.environment);
	let enabled = enabledLayer && enabledLayer.value !== null ? Boolean(enabledLayer.value) : true;
	let enabledSource = enabledLayer ? configPaths[enabledLayer.layer] : undefined;
	if (fromCommandLine && model) {
		// An explicit model on the flag or environment wins over a stored "off".
		enabled = true;
		enabledSource = input.flag !== undefined ? `--${CONFIG_FLAG}` : CONFIG_ENV_VAR;
	}

	return {
		enabled,
		enabledSource,
		model,
		provider: resolveKey<string>(layers, "provider", undefined),
		thinkingLevel: resolveKey<ThinkingLevel | "inherit">(layers, "thinkingLevel", "inherit") ?? "inherit",
		branchSummaries: resolveKey<boolean>(layers, "branchSummaries", true) ?? true,
		fallbackToSessionModel: resolveKey<boolean>(layers, "fallbackToSessionModel", true) ?? true,
		skipIfContextTooSmall: resolveKey<boolean>(layers, "skipIfContextTooSmall", true) ?? true,
		modelSource: model ? modelSource : undefined,
		configPaths,
		warnings,
	};
}

/** Read-modify-write one config file so unrelated keys survive. Returns the path written. */
export function patchConfigFile(path: string, patch: CompactModelConfigFile): string {
	const { config: existing } = readConfigFile(path);
	const next: Record<string, unknown> = { ...existing };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		next[key] = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return path;
}

/** Default config locations: `<agentDir>/compact-model.json` and `<cwd>/.pi/compact-model.json`. */
export function defaultConfigPaths(agentDir: string, cwd: string, configDirName: string): string[] {
	return [join(agentDir, CONFIG_FILE_NAME), join(cwd, configDirName, CONFIG_FILE_NAME)];
}
