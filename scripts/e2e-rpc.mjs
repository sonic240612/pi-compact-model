/**
 * End-to-end driver: starts real pi (RPC mode) with the mock provider fixture plus this
 * extension, then compacts. Cheap and offline: asserts which model made the summarization
 * call by reading the mock provider's request log.
 *
 *   node scripts/e2e-rpc.mjs              // expect the compact model to summarize
 *   node scripts/e2e-rpc.mjs --fallback   // summarizer fails; pi must fall back
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PI_BIN = process.env.PI_BIN ?? "pi";
const wantFallback = process.argv.includes("--fallback");
// --compact-ref <provider/modelId> overrides the compact model for a real-provider run.
// The API key then comes from OPENROUTER_API_KEY (or another provider env key) in this environment.
const refIndex = process.argv.indexOf("--compact-ref");
const compactRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;

const workDir = mkdtempSync(join(tmpdir(), "pi-compact-e2e-"));
const agentDir = join(workDir, "agent");
const callLog = join(workDir, "mock-calls.jsonl");
mkdirSync(agentDir, { recursive: true });
// Small compaction thresholds so three short mock turns are enough to compact.
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 512 } }, null, 2)}\n`);
// Project-level config: exercises the <cwd>/.pi/compact-model.json path.
mkdirSync(join(workDir, ".pi"), { recursive: true });
writeFileSync(join(workDir, ".pi", "compact-model.json"), `${JSON.stringify({ model: "mock/summarizer" }, null, 2)}\n`);

const child = spawn(
	PI_BIN,
	[
		"--mode",
		"rpc",
		"--no-session",
		"--extension",
		join(ROOT, "test", "fixtures", "mock-provider.ts"),
		"--extension",
		join(ROOT, "index.ts"),
	],
	{
		cwd: workDir,
		shell: process.platform === "win32",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_COMPACT_MODEL_DEBUG: "1",
			...(compactRef ? { PI_COMPACT_MODEL: compactRef } : {}),
			MOCK_CALL_LOG: callLog,
			MOCK_FAIL_SUMMARIZER: wantFallback ? "1" : "0",
		},
	},
);

const events = [];
const waiters = [];
child.stdout.on("data", (chunk) => {
	for (const line of chunk.toString().split("\n").filter(Boolean)) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			console.log(`[unparsed stdout] ${line.slice(0, 200)}`);
			continue;
		}
		events.push(event);
		for (const waiter of waiters.splice(0)) waiter();
	}
});
child.stderr.on("data", (chunk) => console.log(`[pi stderr] ${String(chunk).trim().slice(0, 400)}`));

// Extension UI requests (notify/select/input) arrive on stdout as requests; log and answer them.
function handleUiRequest(event) {
	if (!event?.method) return;
	if (event.method === "notify") console.log(`notify(${event.notifyType}): ${String(event.message).slice(0, 300).replace(/\n/g, " | ")}`);
	else console.log(`ui request: ${event.method} ${String(event.title ?? "").slice(0, 80)}`);
	if (event.method === "select" || event.method === "input") {
		child.stdin.write(`${JSON.stringify({ id: event.id, type: "response", command: event.method, success: true, data: null })}\n`);
	}
}

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}
async function sendAndWait(command, timeoutMs = 180000) {
	const before = events.length;
	send(command);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = events.slice(before).find((event) => event.type === "response" && event.command === command.type);
		if (found) return found;
		for (const event of events.slice(before)) handleUiRequest(event);
		await new Promise((resolve) => {
			waiters.push(resolve);
			setTimeout(resolve, 100);
		});
	}
	throw new Error(`timeout waiting for ${command.type}`);
}
async function waitForEvent(type, timeoutMs = 180000) {
	const before = events.length;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = events.slice(before).find((event) => event.type === type);
		if (found) return found;
		await new Promise((resolve) => {
			waiters.push(resolve);
			setTimeout(resolve, 100);
		});
	}
	throw new Error(`timeout waiting for event ${type}`);
}

function readCallLog() {
	try {
		return readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

try {
	const commands = await sendAndWait({ type: "get_commands" });
	const list = Array.isArray(commands.data) ? commands.data : (commands.data?.commands ?? commands.data ?? []);
	console.log(`get_commands data: ${JSON.stringify(list).slice(0, 300)}`);

	const model = await sendAndWait({ type: "set_model", provider: "mock", modelId: "chat" });
	if (!model.success) throw new Error(`set_model failed: ${model.error}`);
	console.log(`session model: ${model.data?.provider}/${model.data?.id}`);

	for (let turn = 0; turn < 3; turn++) {
		const prompt = await sendAndWait({ type: "prompt", message: `Say something long about topic ${turn}. Do not use tools.` });
		if (!prompt.success) throw new Error(`prompt failed: ${prompt.error}`);
	}

	const compact = await sendAndWait({ type: "compact" }, 240000);
	console.log(`compact success=${compact.success}${compact.error ? ` error=${compact.error}` : ""}`);
	if (compact.success) {
		console.log(`  tokensBefore=${compact.data.tokensBefore} estimatedTokensAfter=${compact.data.estimatedTokensAfter}`);
		console.log(`  summary: ${String(compact.data.summary).split("\n")[0]}`);
	}

	const notifications = events.filter((event) => event.method === "notify" && String(event.message).includes("pi-compact-model"));
	for (const note of notifications) console.log(`extension notify(${note.notifyType}): ${String(note.message).slice(0, 200)}`);

	const compactionEnd = events.filter((event) => event.type === "compaction_end");
	console.log(`compaction_end events: ${compactionEnd.length}`);

	// "/compact-model off" must make the next compaction use the session model,
	// and "/compact-model on" must hand it back to the compact model.
	let toggle = { offNotified: false, onNotified: false, statusShowsOff: false, offUsedSessionModel: false, onUsedCompactModel: false };
	if (!wantFallback) {
		const morePrompts = async (count) => {
			for (let turn = 0; turn < count; turn++) {
				await sendAndWait({ type: "prompt", message: `Keep talking about topic ${turn}. Do not use tools.` }, 240000);
			}
		};
		const callsSince = (mark) => readCallLog().slice(mark);

		await morePrompts(2);
		let mark = readCallLog().length;
		await sendAndWait({ type: "prompt", message: "/compact-model off" }, 120000);
		await sendAndWait({ type: "prompt", message: "/compact-model status" }, 120000);
		const compactOff = await sendAndWait({ type: "compact" }, 240000);
		const offCalls = callsSince(mark);
		console.log(`after "off": compact success=${compactOff.success} calls=${JSON.stringify(offCalls.map((call) => call.model))}`);

		await morePrompts(2);
		mark = readCallLog().length;
		await sendAndWait({ type: "prompt", message: "/compact-model on" }, 120000);
		const compactOn = await sendAndWait({ type: "compact" }, 240000);
		const onCalls = callsSince(mark);
		console.log(`after "on": compact success=${compactOn.success} calls=${JSON.stringify(onCalls.map((call) => call.model))}`);

		const notified = (pattern) => events.some((event) => event.method === "notify" && pattern.test(String(event.message)));
		toggle = {
			offNotified: notified(/compact model: off/),
			onNotified: notified(/compact model: on/),
			statusShowsOff: notified(/compact model: off — kept mock\/summarizer/),
			offUsedSessionModel: compactOff.success && offCalls.some((call) => call.model === "mock/chat") && !offCalls.some((call) => call.model === "mock/summarizer"),
			onUsedCompactModel: compactOn.success && onCalls.some((call) => call.model === "mock/summarizer"),
		};
		console.log(`toggle: ${JSON.stringify(toggle)}`);
	}
	const extensionErrors = events.filter((event) => event.type === "extension_error");
	for (const error of extensionErrors) console.log(`extension_error: ${JSON.stringify(error).slice(0, 400)}`);

	const calls = readCallLog();
	const byModel = new Map();
	for (const call of calls) byModel.set(call.model, (byModel.get(call.model) ?? 0) + 1);
	console.log(`mock provider calls: ${JSON.stringify([...byModel.entries()])}`);

	const summaryCalls = calls.filter((call) => call.model === "mock/summarizer");
	const expectations = {
		chatUsed: byModel.get("mock/chat") > 0,
		summarizerCalled: summaryCalls.length > 0,
	};
	console.log(`expectations: ${JSON.stringify(expectations)}`);
	if (wantFallback) {
		const ok = expectations.chatUsed && summaryCalls.length >= 1 && compact.success;
		console.log(ok ? "RESULT: fallback path worked (summarizer failed, pi completed with the session model)" : "RESULT: FAIL");
	} else {
		const ok = compact.success && expectations.summarizerCalled && Object.values(toggle).every(Boolean);
		console.log(ok ? "RESULT: compact model performed the summarization and on/off toggled it" : "RESULT: FAIL");
	}
} catch (error) {
	console.log(`DRIVER ERROR: ${error instanceof Error ? error.stack : String(error)}`);
	process.exitCode = 1;
} finally {
	child.stdin.end();
	child.kill();
	const childExit = new Promise((resolve) => child.once("exit", resolve));
	await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 3000))]);
	try {
		rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
	} catch {
		console.log(`(left test dir behind: ${workDir})`);
	}
}
