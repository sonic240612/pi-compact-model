/**
 * Config file locations, resolved with Pi's own agent directory.
 * The merge and parse logic lives in `./config-merge.ts` so it is testable in isolation.
 */

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_ENV_VAR,
	defaultConfigPaths,
	envFlag,
	mergeConfigs,
	patchConfigFile,
	readConfigFile,
	type CompactModelConfigFile,
	type ConfigScope,
	type EffectiveConfig,
} from "./config-merge.ts";

export * from "./config-merge.ts";

/** [global, project] config paths for a working directory. */
export function configPaths(cwd: string): string[] {
	return defaultConfigPaths(getAgentDir(), cwd, CONFIG_DIR_NAME);
}

export function configPath(scope: ConfigScope, cwd: string): string {
	const [globalPath, projectPath] = configPaths(cwd);
	return scope === "global" ? (globalPath ?? "") : (projectPath ?? "");
}

export const IGNORE_PROJECT_ENV_VAR = "PI_COMPACT_MODEL_NO_PROJECT";

/**
 * Set `PI_COMPACT_MODEL_NO_PROJECT=1` to stop reading `<cwd>/.pi/compact-model.json`. A cloned
 * repository can otherwise choose which of your models receives the summary of your conversation.
 */
export function projectConfigIgnored(): boolean {
	return envFlag(process.env[IGNORE_PROJECT_ENV_VAR]);
}

/** Read both files and apply Pi-style precedence: flag > env > project > global. */
export function loadEffectiveConfig(cwd: string, flagValue?: string): EffectiveConfig {
	const paths = configPaths(cwd);
	const reads = paths.map((path) => readConfigFile(path));
	const ignoreProjectLayer = projectConfigIgnored();
	return mergeConfigs({
		layers: reads.map((read) => read.config),
		configPaths: paths,
		warnings: reads.flatMap((read) => read.warnings),
		environment: process.env[CONFIG_ENV_VAR],
		flag: flagValue,
		ignoreProjectLayer,
	});
}

export function writeConfigFile(scope: ConfigScope, cwd: string, patch: CompactModelConfigFile): string {
	return patchConfigFile(configPath(scope, cwd), patch);
}
