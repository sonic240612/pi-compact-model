/**
 * Opt-in diagnostics: set PI_COMPACT_MODEL_DEBUG=1 to write resolution and failure details
 * to stderr. Pi owns stdout, so diagnostics go to stderr and never touch the TUI or RPC I/O.
 *
 * Everything this module prints is passed through `redactSecrets` first: providers echo the
 * requests they were given, and some of them quote `Authorization` headers or their own key
 * ids inside error bodies. Those strings would otherwise land in a terminal, a log file, or a
 * session transcript that is sent to a model.
 */

const ENABLED = () => process.env.PI_COMPACT_MODEL_DEBUG !== undefined && process.env.PI_COMPACT_MODEL_DEBUG !== "";

/** `name: value` / `"name": "value"` pairs whose value is a credential. */
const CREDENTIAL_FIELD =
	/\b(authorization|proxy-authorization|x[_ -]?api[_ -]?key|api[_ -]?key|apikey|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret[_ -]?key|password)\b(\s*["']?\s*[:=]\s*["']?)[^\r\n"',}]{0,300}/gi;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bbearer\s+[A-Za-z0-9._~+/=\-]{6,}/gi, "Bearer [redacted]"],
	[/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[redacted]"],
	[/\b(AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g, "[redacted]"],
	[/\/keys?\/[0-9a-f]{12,}/gi, "/key/[redacted]"],
	[/\b[0-9a-f]{32,}\b/gi, "[redacted-hex]"],
];

/** Strip anything credential-shaped; leave the readable part of the message intact. */
export function redactSecrets(text: string): string {
	let out = text.replace(CREDENTIAL_FIELD, "$1$2[redacted]");
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

export function debug(...parts: unknown[]): void {
	if (!ENABLED()) return;
	console.error("[pi-compact-model]", ...parts.map((part) => (typeof part === "string" ? redactSecrets(part) : part)));
}

/** Provider errors can be whole JSON payloads; keep one-line notifications readable. */
export function shortError(message: string, limit = 180): string {
	const flattened = redactSecrets(message).replace(/\s+/g, " ").trim();
	return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}

/** Best-effort single-line description of a thrown value. */
export function errorText(error: unknown): string {
	return shortError(error instanceof Error ? error.message : String(error));
}

export function debugError(context: string, error: unknown): void {
	if (!ENABLED()) return;
	const err = error instanceof Error ? error : new Error(String(error));
	console.error(`[pi-compact-model] ${context}: ${redactSecrets(err.stack ?? err.message)}`);
}
