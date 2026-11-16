/**
 * Credential-redaction tests. The fake keys are assembled at runtime on purpose: nothing in
 * this repository looks like a real credential to a scanner, and nothing here is a live key.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { errorText, redactSecrets, shortError } from "../src/debug.ts";

const repeat = (unit: string, times: number) => unit.repeat(times);

test("api keys of the common shapes never survive", () => {
	const fakeKeys = [
		`sk-or-v1-${repeat("0f3e", 16)}`,
		`sk-ant-api03-${repeat("AbCd", 12)}`,
		`sk-proj-${repeat("abcd", 6)}`,
		`AIzaSyA${repeat("1234567890", 2)}abcdefghij`,
		`AKIA${repeat("IOSFODNN", 2)}7ABCDEFGHI`,
		`ghp_${repeat("abcdefghij", 4)}`,
		`xoxb-${repeat("1234567890", 3)}-abcdefghij`,
	];
	assert.equal(fakeKeys.length, 7);
	for (const key of fakeKeys) {
		const redacted = redactSecrets(`Summarization failed: 401 invalid credential ${key}`);
		assert.ok(!redacted.includes(key), `${key.slice(0, 6)}… must be redacted, got: ${redacted}`);
		assert.match(redacted, /redacted/);
	}
});

test("key fields in JSON error bodies are stripped", () => {
	const message = `{"api_key":"sk-or-v1-${repeat("ab", 20)}","authorization": "Bearer sk-or-v1-${repeat("cd", 20)}","error":"nope"}`;
	const redacted = redactSecrets(message);
	assert.ok(!/sk-or-v1-[a-z0-9]+/i.test(redacted), redacted);
	assert.match(redacted, /"api_key":"\[redacted\]"/, redacted);
	assert.match(redacted, /"authorization":\s*"?\[redacted\]/, redacted);
	assert.ok(redacted.includes("nope"), "the useful part of the error must survive");
});

test("authorization headers are redacted as one unit", () => {
	const header = redactSecrets(`401 Unauthorized: the request had Authorization: Bearer ${repeat("abcdef", 6)}`);
	assert.ok(!/abcdefabcdef/.test(header), header);
	assert.match(header, /Authorization: \[redacted\]/, header);

	const scheme = redactSecrets(`the upstream rejected Authorization scheme Bearer ${repeat("ghijkl", 6)}`);
	assert.ok(!/ghijklghijkl/.test(scheme), scheme);
});

test("provider key ids embedded in URLs are stripped", () => {
	const keyId = repeat("ab31521", 9);
	const redacted = redactSecrets(`Key limit exceeded. Manage it using https://openrouter.example/workspaces/default/keys/${keyId}`);
	assert.ok(!redacted.includes(keyId), redacted);
	assert.ok(redacted.includes("openrouter.example"), "the remediation link should stay readable");
});

test("notifications and error text are redacted and shortened", () => {
	const long = `Summarization failed: 401 {"error":{"message":"invalid api_key sk-or-v1-${repeat("a", 40)}","type":"invalid_request_error"}}`;
	const shown = errorText(new Error(long));
	assert.ok(!/sk-or-v1/.test(shown), shown);
	assert.ok(shown.length <= 181, `expected <= 181 chars, got ${shown.length}`);
	const twoLine = shortError(`line one\nline two with token ${`ghci_${repeat("xyz", 12)}`}`);
	assert.match(twoLine, /^line one line two with token/);
});

test("benign text is left alone", () => {
	const text = "429: Too Many Requests for model openrouter/nvidia/nemotron-3.5-super-vl:free; limit resets at 12:00Z, contextWindow 1000000";
	assert.equal(redactSecrets(text), text);
});
