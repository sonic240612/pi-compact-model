import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLE_VALUES, envFlag, mergeConfigs, parseConfigFile, patchConfigFile } from "../src/config-merge.ts";

test("defaults are inert: no model, everything on", () => {
	const config = mergeConfigs({ layers: [{}, {}], configPaths: ["/g/compact-model.json", "/p/compact-model.json"] });
	assert.equal(config.model, undefined);
	assert.equal(config.modelSource, undefined);
	assert.equal(config.thinkingLevel, "inherit");
	assert.equal(config.branchSummaries, true);
	assert.equal(config.fallbackToSessionModel, true);
	assert.equal(config.skipIfContextTooSmall, true);
});

test("global config is reported with its path", () => {
	const config = mergeConfigs({
		layers: [{ model: "openrouter/google/gemini-2.5-flash" }, {}],
		configPaths: ["/g/compact-model.json", "/p/compact-model.json"],
	});
	assert.equal(config.model, "openrouter/google/gemini-2.5-flash");
	assert.equal(config.modelSource, "/g/compact-model.json");
});

test("project layer wins key by key, and null clears a global key", () => {
	const config = mergeConfigs({
		layers: [
			{ model: "openrouter/google/gemini-2.5-flash", branchSummaries: false, thinkingLevel: "high" },
			{ model: null, branchSummaries: true },
		],
		configPaths: ["/g/compact-model.json", "/p/compact-model.json"],
	});
	assert.equal(config.model, undefined);
	assert.equal(config.branchSummaries, true);
	assert.equal(config.thinkingLevel, "high");
});

test("PI_COMPACT_MODEL overrides files, and --compact-model overrides the environment", () => {
	const layers = [{ model: "openrouter/google/gemini-2.5-flash" }, {}];
	const fromEnv = mergeConfigs({ layers, configPaths: ["/g", "/p"], environment: "anthropic/claude-haiku-4.5" });
	assert.equal(fromEnv.model, "anthropic/claude-haiku-4.5");
	assert.equal(fromEnv.modelSource, "PI_COMPACT_MODEL");

	const fromFlag = mergeConfigs({ layers, configPaths: ["/g", "/p"], environment: "anthropic/claude-haiku-4.5", flag: "openrouter/anthropic/claude-haiku-4.5" });
	assert.equal(fromFlag.model, "openrouter/anthropic/claude-haiku-4.5");
	assert.equal(fromFlag.modelSource, "--compact-model");
});

test("disable words switch the extension off", () => {
	for (const value of DISABLE_VALUES) {
		const config = mergeConfigs({ layers: [{ model: value }], configPaths: ["/g"] });
		assert.equal(config.model, undefined, `${value} should disable the compact model`);
	}
});

test("invalid entries are reported instead of applied", () => {
	const { config, warnings } = parseConfigFile(
		JSON.stringify({ model: 42, thinkingLevel: "ultra", branchSummaries: "yes", nope: true }),
		"/g/compact-model.json",
	);
	assert.deepEqual(config, {});
	assert.equal(warnings.length, 4);
	assert.match(warnings.join("\n"), /must be a string or null/);
	assert.match(warnings.join("\n"), /unknown setting "nope"/);
});

test("a broken file never throws", () => {
	const { config, warnings } = parseConfigFile("{ not json", "/g/compact-model.json");
	assert.deepEqual(config, {});
	assert.match(warnings[0] ?? "", /invalid JSON/);
});

test("patchConfigFile keeps unrelated keys and creates the directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-model-"));
	const path = join(dir, ".pi", "compact-model.json");
	patchConfigFile(path, { model: "openrouter/google/gemini-2.5-flash", thinkingLevel: "low" });
	patchConfigFile(path, { model: null, branchSummaries: false });
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.model, null);
	assert.equal(written.thinkingLevel, "low");
	assert.equal(written.branchSummaries, false);
});

test("enabled defaults to true and a file can switch it off while keeping the model", () => {
	const off = mergeConfigs({
		layers: [{ enabled: false, model: "openrouter/nvidia/nemotron-3.5-super-vl:free" }, {}],
		configPaths: ["/g/compact-model.json", "/p/compact-model.json"],
	});
	assert.equal(off.enabled, false);
	assert.equal(off.model, "openrouter/nvidia/nemotron-3.5-super-vl:free", "off must keep the model for /compact-model on");
	assert.equal(off.enabledSource, "/g/compact-model.json");
});

test("the project layer can turn a global compact model off or back on", () => {
	const global = { model: "openrouter/nvidia/nemotron-3.5-super-vl:free" };
	const disabled = mergeConfigs({ layers: [global, { enabled: false }], configPaths: ["/g", "/p"] });
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.enabledSource, "/p");

	const reEnabled = mergeConfigs({ layers: [{ ...global, enabled: false }, { enabled: true }], configPaths: ["/g", "/p"] });
	assert.equal(reEnabled.enabled, true);
	assert.equal(reEnabled.enabledSource, "/p");

	const cleared = mergeConfigs({ layers: [{ ...global, enabled: false }, { enabled: null }], configPaths: ["/g", "/p"] });
	assert.equal(cleared.enabled, true, "a null project value clears the global off and returns to the default");
});

test("a model from the flag or environment overrides a stored off", () => {
	const layers = [{ enabled: false, model: "openrouter/nvidia/nemotron-3.5-super-vl:free" }];
	const fromEnv = mergeConfigs({ layers, configPaths: ["/g"], environment: "openrouter/cohere/north-mini-code:free" });
	assert.equal(fromEnv.enabled, true);
	assert.equal(fromEnv.enabledSource, "PI_COMPACT_MODEL");

	const fromFlag = mergeConfigs({ layers, configPaths: ["/g"], flag: "openrouter/cohere/north-mini-code:free" });
	assert.equal(fromFlag.enabled, true);
	assert.equal(fromFlag.enabledSource, "--compact-model");

	const offByEnv = mergeConfigs({ layers: [{ model: "openrouter/nvidia/nemotron-3.5-super-vl:free" }], configPaths: ["/g"], environment: "off" });
	assert.equal(offByEnv.model, undefined);
});

test("enabled is validated like the other boolean keys", () => {
	const { config, warnings } = parseConfigFile(JSON.stringify({ enabled: "maybe" }), "/g/compact-model.json");
	assert.deepEqual(config, {});
	assert.match(warnings[0] ?? "", /"enabled" must be a boolean or null/);
});

test("patchConfigFile toggles enabled without touching the model", () => {
	const dir = mkdtempSync(join(tmpdir(), "compact-toggle-"));
	const path = join(dir, "compact-model.json");
	patchConfigFile(path, { model: "openrouter/nvidia/nemotron-3.5-super-vl:free" });
	patchConfigFile(path, { enabled: false });
	const written = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(written.model, "openrouter/nvidia/nemotron-3.5-super-vl:free");
	assert.equal(written.enabled, false);
	assert.deepEqual(mergeConfigs({ layers: [written, {}], configPaths: [path] }).enabled, false);
	patchConfigFile(path, { enabled: true });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).enabled, true);
});

test("PI_COMPACT_MODEL_NO_PROJECT drops the project layer entirely", () => {
	const config = mergeConfigs({
		layers: [{ model: "openrouter/nvidia/nemotron-3.5-super-vl:free" }, { model: "openrouter/someone-elses/relay", enabled: false, branchSummaries: false }],
		configPaths: ["/g/compact-model.json", "/p/compact-model.json"],
		ignoreProjectLayer: true,
	});
	assert.equal(config.model, "openrouter/nvidia/nemotron-3.5-super-vl:free");
	assert.equal(config.enabled, true);
	assert.equal(config.branchSummaries, true);
	assert.deepEqual(config.configPaths, ["/g/compact-model.json"]);
});

test("envFlag reads the usual truthy and falsy spellings", () => {
	for (const value of ["1", "true", "TRUE", "yes", "on", "1 "]) assert.equal(envFlag(value), true, `${value} should be true`);
	for (const value of [undefined, "", "0", "false", "off", "no", " "]) assert.equal(envFlag(value), false, `${value} should be false`);
});
