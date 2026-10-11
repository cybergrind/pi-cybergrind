// Smoke test for the subagent runner against a real pi process.
//
// Run with:
//   PI_CMD=/path/to/pi-test.sh npm run test:subagent
//
// Or, if `pi` is on PATH as a real executable, just `npm run test:subagent`.
//
// Validates:
//   - Process spawn via resolvePiCommand()
//   - JSONL parse + final text extraction
//   - Registry: run is registered, transitions starting → running → done
//   - Events: tool_call / assistant_text / usage append in order
//   - run:start / run:progress / run:end emissions
//   - A second run that must use a tool records a tool_call event, and
//     --append-system-prompt (extraSystemPrompt) reaches the child

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCommand, runChildPi } from "../extensions/lib/pi-runner.ts";
import { events, listRuns, getRun, snapshotRun, type Run } from "../extensions/lib/run-registry.ts";

const TIMEOUT_MS = 120_000;

interface EventLog {
	starts: number;
	progress: number;
	ends: number;
	lastStatus?: string;
}

async function main() {
	const spec = resolvePiCommand();
	console.log(`[smoke] resolved pi: ${spec.source} → ${spec.command} ${spec.prefixArgs.join(" ")}`);

	const log: EventLog = { starts: 0, progress: 0, ends: 0 };
	let observedRun: Run | undefined;
	events.on("run:start", (run) => {
		log.starts++;
		observedRun ??= run;
	});
	events.on("run:progress", (_run) => {
		log.progress++;
	});
	events.on("run:end", (run) => {
		log.ends++;
		log.lastStatus = run.status;
	});

	const controller = new AbortController();
	const timer = setTimeout(() => {
		console.error(`[smoke] aborting after ${TIMEOUT_MS}ms`);
		controller.abort();
	}, TIMEOUT_MS);

	const result = await runChildPi({
		task: "Respond with exactly the word READY (no punctuation, no quotes). Use no tools.",
		parentDepth: 0,
		signal: controller.signal,
		onProgress: (run) => {
			const last = run.lastAssistantText ? run.lastAssistantText.slice(0, 60).replace(/\s+/g, " ") : "(running)";
			process.stderr.write(`  [${run.status}] ${run.usage.turns}t ↑${run.usage.input} ↓${run.usage.output}  ${last}\n`);
		},
	});

	console.log(`[smoke] runId=${result.runId}`);
	console.log(`[smoke] exit=${result.exitCode} stop=${result.stopReason ?? "(none)"} took=${result.took.toFixed(2)}s`);
	console.log(`[smoke] usage=${JSON.stringify(result.usage)}`);
	console.log(`[smoke] finalText="${result.finalText}"`);
	console.log(`[smoke] events emitted: starts=${log.starts} progress=${log.progress} ends=${log.ends} lastStatus=${log.lastStatus}`);

	const runFromRegistry = getRun(result.runId);
	console.log(`[smoke] registry has run: ${runFromRegistry ? "yes" : "no"}`);
	if (runFromRegistry) {
		const snap = snapshotRun(runFromRegistry);
		const eventTypes = new Map<string, number>();
		for (const ev of snap.events) eventTypes.set(ev.type, (eventTypes.get(ev.type) ?? 0) + 1);
		console.log(`[smoke] event counts: ${[...eventTypes].map(([t, n]) => `${t}=${n}`).join(", ")}`);
		console.log(`[smoke] durationMs=${snap.durationMs}`);
	}

	// Second run: the child has to call a tool, and gets an extra system prompt.
	// The token lives only in a file, so the answer cannot be produced without a tool.
	const tokenDir = mkdtempSync(join(tmpdir(), "pi-subagent-smoke-"));
	const tokenFile = join(tokenDir, "token.txt");
	const token = `tok-${randomUUID()}`;
	writeFileSync(tokenFile, `${token}\n`);
	const toolResult = await runChildPi({
		task: `Run the shell command \`cat ${tokenFile}\` with your bash tool, then reply with the command's exact output followed by your codeword.`,
		parentDepth: 0,
		extraSystemPrompt: "Your codeword is ZEBRA-42. State it when asked for your codeword.",
		signal: controller.signal,
	});
	rmSync(tokenDir, { recursive: true, force: true });
	const toolRun = getRun(toolResult.runId);
	const toolCalls = toolRun?.events.filter((e) => e.type === "tool_call").map((e) => (e.type === "tool_call" ? e.tool : "")) ?? [];
	console.log(`[smoke] tool run: exit=${toolResult.exitCode} tools=[${toolCalls.join(",")}] finalText="${toolResult.finalText.slice(0, 120).replace(/\s+/g, " ")}"`);
	clearTimeout(timer);

	const ran = listRuns();
	console.log(`[smoke] listRuns() returned ${ran.length} run(s)`);

	const checks: Array<[string, boolean]> = [
		["exit code 0", result.exitCode === 0],
		["finalText contains READY", /READY/i.test(result.finalText)],
		["stopReason not aborted/error", result.stopReason !== "aborted" && result.stopReason !== "error"],
		["run:start fired once per run", log.starts === 2],
		["run:end fired once per run", log.ends === 2],
		["progress events > 0", log.progress > 0],
		["final status = done", log.lastStatus === "done"],
		["registry has the run", !!runFromRegistry],
		["observed run matches result", observedRun?.id === result.runId],
		["registry run has assistant_text event", !!runFromRegistry?.events.some((e) => e.type === "assistant_text")],
		["registry run has usage event", !!runFromRegistry?.events.some((e) => e.type === "usage")],
		["tool run: exit code 0", toolResult.exitCode === 0],
		["tool run: registry recorded a tool_call event", toolCalls.length > 0],
		["tool run: output carries the file's token", toolResult.finalText.includes(token)],
		["tool run: extra system prompt reached the child", /ZEBRA-42/.test(toolResult.finalText)],
	];

	let pass = true;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "✓" : "✗"} ${name}`);
		if (!ok) pass = false;
	}

	if (!pass) {
		console.error(`[smoke] FAIL`);
		process.exit(1);
	}
	console.log(`[smoke] PASS`);
}

main().catch((err) => {
	console.error(`[smoke] exception:`, err);
	process.exit(1);
});
