import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Module-level pool of *interactive* subagents — long-lived nested pi sessions
// you can focus and talk to (contrast ./run-registry.ts, which tracks one-shot
// `subagent` tool/command dispatches that run to completion).
//
// Each agent is driven by an AgentClient (the transport). The real one wraps
// pi's RPC mode (see ./rpc-agent-client.ts); tests inject a fake. The pool is
// the single source of truth for the switcher overlay and the input router.
//
// Emitted events (subscribe via `poolEvents.on`):
//   "pool:add"     (agent)  — a new interactive subagent appeared
//   "pool:update"  (agent)  — status / lastText / lastTool / turns changed
//   "pool:remove"  (agent)  — agent purged from the pool

export type AgentStatus = "starting" | "idle" | "busy" | "stopped" | "error";

/** Semantic events the transport reports up to the pool. */
export type AgentClientEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "assistant_text"; text: string }
	| { type: "tool_call"; tool: string }
	| { type: "error"; message: string }
	| { type: "exit"; code: number };

/** Transport contract for one interactive subagent. */
export interface AgentClient {
	start(): Promise<void>;
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	onEvent(cb: (ev: AgentClientEvent) => void): () => void;
}

export interface SpawnAgentOptions {
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
}

export type ClientFactory = (opts: SpawnAgentOptions) => AgentClient;

export interface InteractiveAgent {
	id: string;
	name: string;
	task: string;
	status: AgentStatus;
	createdAt: number;
	startedAt?: number;
	lastText: string;
	lastTool?: string;
	turns: number;
	errorMessage?: string;
}

interface Entry {
	agent: InteractiveAgent;
	client: AgentClient;
	unsubscribe: () => void;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const entries = new Map<string, Entry>();
let defaultFactory: ClientFactory | undefined;

export interface PoolEvents {
	on(event: "pool:add" | "pool:update" | "pool:remove", handler: (agent: InteractiveAgent) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
}

export const poolEvents: PoolEvents = {
	on: (event, handler) => emitter.on(event, handler as (...args: unknown[]) => void),
	off: (event, handler) => emitter.off(event, handler),
};

export function setDefaultClientFactory(factory: ClientFactory): void {
	defaultFactory = factory;
}

/** First few words of the task, capped — a friendly label for the switcher. */
export function deriveName(task: string): string {
	const flat = task.replace(/\s+/g, " ").trim();
	if (flat.length <= 40) return flat || "subagent";
	return `${flat.slice(0, 39)}…`;
}

const ACTIVE: AgentStatus[] = ["starting", "idle", "busy"];

function emit(event: "pool:add" | "pool:update" | "pool:remove", agent: InteractiveAgent): void {
	emitter.emit(event, agent);
}

function handleEvent(id: string, ev: AgentClientEvent): void {
	const entry = entries.get(id);
	if (!entry) return;
	const a = entry.agent;

	switch (ev.type) {
		case "agent_start":
			a.status = "busy";
			break;
		case "agent_end":
			a.status = "idle";
			a.turns += 1;
			break;
		case "assistant_text":
			a.lastText = ev.text;
			break;
		case "tool_call":
			a.lastTool = ev.tool;
			break;
		case "error":
			a.status = "error";
			a.errorMessage = ev.message;
			break;
		case "exit":
			if (a.status !== "error") a.status = "stopped";
			break;
	}
	emit("pool:update", a);
}

export async function spawnAgent(opts: SpawnAgentOptions, factory?: ClientFactory): Promise<InteractiveAgent> {
	const make = factory ?? defaultFactory;
	if (!make) throw new Error("agent-pool: no client factory configured");

	const agent: InteractiveAgent = {
		id: randomUUID(),
		name: opts.name?.trim() || deriveName(opts.task),
		task: opts.task,
		status: "starting",
		createdAt: Date.now(),
		lastText: "",
		turns: 0,
	};

	const client = make(opts);
	const unsubscribe = client.onEvent((ev) => handleEvent(agent.id, ev));
	entries.set(agent.id, { agent, client, unsubscribe });
	emit("pool:add", agent);

	try {
		await client.start();
	} catch (err) {
		agent.status = "error";
		agent.errorMessage = (err as Error).message;
		emit("pool:update", agent);
		throw err;
	}

	agent.status = "idle";
	agent.startedAt = Date.now();
	emit("pool:update", agent);

	// Kick off the initial task. The resulting agent_start/agent_end events
	// drive the status back through busy → idle.
	agent.status = "busy";
	await client.prompt(opts.task);
	emit("pool:update", agent);

	return agent;
}

export function listAgents(filter: { active?: boolean } = {}): InteractiveAgent[] {
	const out: InteractiveAgent[] = [];
	for (const { agent } of entries.values()) {
		if (filter.active && !ACTIVE.includes(agent.status)) continue;
		out.push(agent);
	}
	out.sort((a, b) => a.createdAt - b.createdAt);
	return out;
}

export function getAgent(id: string): InteractiveAgent | undefined {
	return entries.get(id)?.agent;
}

/**
 * Deliver a line of user input to a subagent. Idle agents get a fresh prompt;
 * busy (or still-starting) agents get a follow-up that pi appends after the
 * current turn. Returns the delivery mode, or undefined when the agent is gone
 * or terminated (stopped/error) and cannot accept input.
 */
export function sendToAgent(id: string, text: string): "prompt" | "followUp" | undefined {
	const entry = entries.get(id);
	if (!entry) return undefined;
	const a = entry.agent;
	if (a.status === "stopped" || a.status === "error") return undefined;

	if (a.status === "busy" || a.status === "starting") {
		void entry.client.followUp(text);
		return "followUp";
	}
	// idle → new prompt; flip to busy optimistically so a rapid second line
	// queues as a follow-up rather than racing a fresh prompt.
	a.status = "busy";
	void entry.client.prompt(text);
	emit("pool:update", a);
	return "prompt";
}

/** Interrupt a busy agent's current turn. Returns true if an abort was sent. */
export function interruptAgent(id: string): boolean {
	const entry = entries.get(id);
	if (!entry) return false;
	if (entry.agent.status !== "busy") return false;
	void entry.client.abort();
	return true;
}

/** Shut a subagent down and mark it stopped (kept in the pool for visibility). */
export async function stopAgent(id: string): Promise<void> {
	const entry = entries.get(id);
	if (!entry) return;
	await entry.client.stop();
	if (entry.agent.status !== "error") entry.agent.status = "stopped";
	emit("pool:update", entry.agent);
}

/**
 * Stop the underlying client and drop the agent from the pool entirely.
 * Use when the user dismisses an agent from the switcher — combines what would
 * otherwise be a stopAgent + removeAgent pair, and is safe to fire-and-forget.
 */
export async function closeAgent(id: string): Promise<void> {
	const entry = entries.get(id);
	if (!entry) return;
	try {
		await entry.client.stop();
	} catch {
		/* best-effort: still remove from the pool even if shutdown failed */
	}
	removeAgent(id);
}

/** Remove a terminated agent from the pool entirely. */
export function removeAgent(id: string): boolean {
	const entry = entries.get(id);
	if (!entry) return false;
	entry.unsubscribe();
	entries.delete(id);
	emit("pool:remove", entry.agent);
	return true;
}

// Test-only escape hatch. Don't call in production code.
export function _resetPool(): void {
	for (const { unsubscribe } of entries.values()) unsubscribe();
	entries.clear();
	emitter.removeAllListeners();
	defaultFactory = undefined;
}
