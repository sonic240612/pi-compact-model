/**
 * Branch summarization for `/tree` navigation, run on the compact model.
 *
 * Kept separate from the extension wiring so the option mapping and result shape can be
 * tested with a stub stream function (pi has no RPC command for tree navigation).
 */

import type { Api, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { debugError, errorText } from "./debug.ts";

export interface BranchRunOptions {
	entries: Parameters<typeof generateBranchSummary>[0];
	model: Model<Api>;
	signal: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	customInstructions?: string;
	replaceInstructions?: boolean;
	reserveTokens: number;
	streamFn: StreamFn;
	retry: RetryPolicy;
	/** Injectable for tests; defaults to Pi's own branch summarization. */
	summarize?: typeof generateBranchSummary;
}

/** Shape the `session_before_tree` hook expects back. */
export interface CompactBranchSummary {
	summary: string;
	details: { readFiles: string[]; modifiedFiles: string[] };
	usage?: Usage;
}

export type BranchRunResult = { ok: true; summary: CompactBranchSummary } | { ok: false; error: string };

/** Run pi's own branch summarization against the compact model. Never throws. */
export async function runBranchSummary(options: BranchRunOptions): Promise<BranchRunResult> {
	try {
		const summarize = options.summarize ?? generateBranchSummary;
		const result = await summarize(options.entries, {
			model: options.model,
			signal: options.signal,
			thinkingLevel: options.thinkingLevel,
			customInstructions: options.customInstructions,
			replaceInstructions: options.replaceInstructions,
			reserveTokens: options.reserveTokens,
			streamFn: options.streamFn,
			retry: options.retry,
		});
		if (options.signal.aborted) return { ok: false, error: "aborted" };
		if (!result.summary) {
			return { ok: false, error: errorText(result.error ?? "the compact model returned no summary") };
		}
		return {
			ok: true,
			summary: {
				summary: result.summary,
				details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
				usage: result.usage,
			},
		};
	} catch (error) {
		debugError("branch summarization failed", error);
		if (options.signal.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: errorText(error) };
	}
}
