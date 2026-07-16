import { describe, test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
	_resetPool,
	closeAgent,
	getAgent,
	interruptAgent,
	listAgents,
	poolEvents,
	sendToAgent,
	spawnAgent,
	stopAgent,
	type AgentClient,
	type AgentClientEvent,
	type InteractiveAgent,
} from "../extensions/lib/agent-pool.ts";

// A controllable in-memory AgentClient. Records every call and lets the test
// drive the event stream by hand, so the pool's state machine is exercised
// without spawning a real pi process.
class FakeClient implements AgentClient {
	calls: string[] = [];
	started = false;
	stopped = false;
	startError?: Error;
	private listeners = new Set<(ev: AgentClientEvent) => void>();

	constructor(opts?: { startError?: Error }) {
		this.startError = opts?.startError;
	}

	async start(): Promise<void> {
		this.calls.push("start");
		if (this.startError) throw this.startError;
		this.started = true;
	}
	async prompt(text: string): Promise<void> {
		this.calls.push(`prompt:${text}`);
	}
	async followUp(text: string): Promise<void> {
		this.calls.push(`followUp:${text}`);
	}
	async abort(): Promise<void> {
		this.calls.push("abort");
	}
	async stop(): Promise<void> {
		this.calls.push("stop");
		this.stopped = true;
	}
	onEvent(cb: (ev: AgentClientEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	emit(ev: AgentClientEvent): void {
		for (const l of this.listeners) l(ev);
	}
}

let last: FakeClient;
const factory = () => (last = new FakeClient());

beforeEach(() => {
	_resetPool();
});

describe("spawnAgent", () => {
	test("creates a tracked agent, starts the client, and sends the initial task", async () => {
		const agent = await spawnAgent({ task: "do the thing" }, factory);
		assert.ok(agent.id);
		assert.equal(agent.task, "do the thing");
		assert.equal(getAgent(agent.id)?.id, agent.id);
		assert.ok(last.calls.includes("start"));
		assert.ok(last.calls.includes("prompt:do the thing"));
	});

	test("derives a short name from the task when none is given", async () => {
		const agent = await spawnAgent({ task: "investigate the failing build pipeline thoroughly please" }, factory);
		assert.ok(agent.name.length > 0);
		assert.ok(agent.name.length <= 40);
	});

	test("uses an explicit name when provided", async () => {
		const agent = await spawnAgent({ task: "x", name: "builder" }, factory);
		assert.equal(agent.name, "builder");
	});

	test("emits pool:add", async () => {
		const seen: InteractiveAgent[] = [];
		poolEvents.on("pool:add", (a) => seen.push(a));
		const agent = await spawnAgent({ task: "x" }, factory);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].id, agent.id);
	});

	test("marks the agent errored and rethrows when start fails", async () => {
		const failing = () => (last = new FakeClient({ startError: new Error("spawn boom") }));
		await assert.rejects(() => spawnAgent({ task: "x" }, failing), /spawn boom/);
		const agents = listAgents();
		assert.equal(agents.length, 1);
		assert.equal(agents[0].status, "error");
		assert.match(agents[0].errorMessage ?? "", /spawn boom/);
	});
});

describe("event-driven status", () => {
	test("agent_start → busy, agent_end → idle and bumps turns", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_start" });
		assert.equal(getAgent(agent.id)?.status, "busy");
		last.emit({ type: "agent_end" });
		assert.equal(getAgent(agent.id)?.status, "idle");
		assert.equal(getAgent(agent.id)?.turns, 1);
	});

	test("assistant_text updates lastText; tool_call updates lastTool", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "assistant_text", text: "hello there" });
		last.emit({ type: "tool_call", tool: "bash" });
		assert.equal(getAgent(agent.id)?.lastText, "hello there");
		assert.equal(getAgent(agent.id)?.lastTool, "bash");
	});

	test("exit → stopped", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "exit", code: 0 });
		assert.equal(getAgent(agent.id)?.status, "stopped");
	});

	test("error event → error status with message", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "error", message: "kaboom" });
		assert.equal(getAgent(agent.id)?.status, "error");
		assert.equal(getAgent(agent.id)?.errorMessage, "kaboom");
	});

	test("emits pool:update on every event", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		let updates = 0;
		poolEvents.on("pool:update", () => updates++);
		last.emit({ type: "agent_start" });
		last.emit({ type: "assistant_text", text: "hi" });
		assert.equal(updates, 2);
		assert.equal(agent.id, listAgents()[0].id);
	});
});

describe("sendToAgent", () => {
	test("idle agent → prompt", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_end" }); // idle
		const mode = sendToAgent(agent.id, "next step");
		assert.equal(mode, "prompt");
		assert.ok(last.calls.includes("prompt:next step"));
	});

	test("busy agent → followUp", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_start" }); // busy
		const mode = sendToAgent(agent.id, "also do this");
		assert.equal(mode, "followUp");
		assert.ok(last.calls.includes("followUp:also do this"));
	});

	test("prompting an idle agent optimistically flips it to busy", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_end" }); // idle
		sendToAgent(agent.id, "go");
		assert.equal(getAgent(agent.id)?.status, "busy");
	});

	test("returns undefined for unknown id", () => {
		assert.equal(sendToAgent("nope", "x"), undefined);
	});

	test("returns undefined for a stopped agent and does not send", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "exit", code: 0 });
		const before = last.calls.length;
		assert.equal(sendToAgent(agent.id, "x"), undefined);
		assert.equal(last.calls.length, before);
	});
});

describe("interruptAgent", () => {
	test("aborts a busy agent", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_start" });
		assert.equal(interruptAgent(agent.id), true);
		assert.ok(last.calls.includes("abort"));
	});

	test("does nothing for an idle agent", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		last.emit({ type: "agent_end" });
		assert.equal(interruptAgent(agent.id), false);
		assert.ok(!last.calls.includes("abort"));
	});

	test("returns false for unknown id", () => {
		assert.equal(interruptAgent("nope"), false);
	});
});

describe("stopAgent", () => {
	test("stops the client and marks the agent stopped", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		await stopAgent(agent.id);
		assert.ok(last.calls.includes("stop"));
		assert.equal(getAgent(agent.id)?.status, "stopped");
	});
});

describe("closeAgent", () => {
	test("stops the client and removes the agent from the pool", async () => {
		const agent = await spawnAgent({ task: "x" }, factory);
		const events: string[] = [];
		poolEvents.on("pool:remove", (a) => events.push(`remove:${a.id}`));
		await closeAgent(agent.id);
		assert.ok(last.calls.includes("stop"));
		assert.equal(getAgent(agent.id), undefined);
		assert.deepEqual(events, [`remove:${agent.id}`]);
	});

	test("is a no-op for unknown id", async () => {
		await closeAgent("nope"); // must not throw
	});
});

describe("listAgents", () => {
	test("sorts by createdAt and supports active-only filter", async () => {
		const a = await spawnAgent({ task: "a" }, factory);
		await new Promise((r) => setTimeout(r, 5));
		const b = await spawnAgent({ task: "b" }, factory);
		const bClient = last;
		bClient.emit({ type: "exit", code: 0 }); // b stopped

		const all = listAgents();
		assert.deepEqual(all.map((x) => x.id), [a.id, b.id]);

		const active = listAgents({ active: true });
		assert.deepEqual(active.map((x) => x.id), [a.id]);
	});
});
