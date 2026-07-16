// Smoke test for interactive subagents against a real `pi --mode rpc` child.
//
// Run with:
//   PI_CMD=/path/to/pi-test.sh npm run test:interactive
// or, if `pi` is a real executable on PATH, just `npm run test:interactive`.
//
// Validates the full live loop the switcher depends on:
//   - RpcAgentClient spawns a real child via resolvePiCommand()
//   - pool transitions starting → idle after the initial task completes
//   - a follow-up turn is delivered and produces new output
//   - interruptAgent() aborts a busy turn
//   - stopAgent() tears the child down

import {
	_resetPool,
	getAgent,
	interruptAgent,
	listAgents,
	poolEvents,
	sendToAgent,
	setDefaultClientFactory,
	spawnAgent,
	stopAgent,
	type AgentStatus,
} from "../extensions/lib/agent-pool.ts";
import { createRpcAgentClient } from "../extensions/lib/rpc-agent-client.ts";
import { describePiSpawnSpec, resolvePiCommand } from "../extensions/lib/pi-runner.ts";

const TIMEOUT_MS = 120_000;

function waitForStatus(id: string, want: AgentStatus, minTurns = 0, timeout = TIMEOUT_MS): Promise<void> {
	return new Promise((resolve, reject) => {
		const check = () => {
			const a = getAgent(id);
			if (a && a.status === want && a.turns >= minTurns) {
				poolEvents.off("pool:update", onUpdate);
				clearTimeout(timer);
				resolve();
			}
		};
		const onUpdate = () => check();
		const timer = setTimeout(() => {
			poolEvents.off("pool:update", onUpdate);
			reject(new Error(`timeout waiting for status=${want} (turns≥${minTurns}); last=${getAgent(id)?.status}`));
		}, timeout);
		poolEvents.on("pool:update", onUpdate);
		check();
	});
}

async function main() {
	setDefaultClientFactory(createRpcAgentClient);
	console.log(`[smoke] resolved pi: ${describePiSpawnSpec(resolvePiCommand())}`);

	const agent = await spawnAgent({ task: "Reply with the single word READY and nothing else. Use no tools." });
	console.log(`[smoke] spawned ${agent.id.slice(0, 8)} "${agent.name}"`);

	await waitForStatus(agent.id, "idle", 1);
	const firstText = getAgent(agent.id)?.lastText ?? "";
	console.log(`[smoke] after task #1: status=${getAgent(agent.id)?.status} text="${firstText.slice(0, 60)}"`);

	const mode = sendToAgent(agent.id, "Now reply with the single word DONE and nothing else.");
	console.log(`[smoke] follow-up delivered as: ${mode}`);
	await waitForStatus(agent.id, "idle", 2);
	const secondText = getAgent(agent.id)?.lastText ?? "";
	console.log(`[smoke] after task #2: text="${secondText.slice(0, 60)}"`);

	// Interrupt: start a long turn, then abort while busy.
	sendToAgent(agent.id, "Count slowly from 1 to 100, one number per line.");
	await waitForStatus(agent.id, "busy");
	const interrupted = interruptAgent(agent.id);
	console.log(`[smoke] interrupt while busy returned: ${interrupted}`);
	await waitForStatus(agent.id, "idle").catch(() => {});

	await stopAgent(agent.id);
	console.log(`[smoke] after stop: status=${getAgent(agent.id)?.status}, pool size=${listAgents().length}`);

	const checks: Array<[string, boolean]> = [
		["task #1 produced READY", /READY/i.test(firstText)],
		["follow-up delivered (prompt|followUp)", mode === "prompt" || mode === "followUp"],
		["task #2 produced DONE", /DONE/i.test(secondText)],
		["interrupt returned true while busy", interrupted === true],
		["agent stopped", getAgent(agent.id)?.status === "stopped"],
	];

	let pass = true;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "✓" : "✗"} ${name}`);
		if (!ok) pass = false;
	}

	_resetPool();
	if (!pass) {
		console.error("[smoke] FAIL");
		process.exit(1);
	}
	console.log("[smoke] PASS");
	process.exit(0);
}

main().catch((err) => {
	console.error("[smoke] exception:", err);
	process.exit(1);
});
