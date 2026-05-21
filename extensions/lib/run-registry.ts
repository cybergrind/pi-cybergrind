import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Module-level registry of subagent runs. Single source of truth for the
// state of any /subagent or `subagent` tool invocation in this pi process.
//
// Consumers (the subagent runner, the future panel, abort handlers) read
// from `listRuns()` / `getRun()` and subscribe via `events.on(...)`.
//
// Emitted events:
//   "run:start"     (run: Run)
//   "run:progress"  (run: Run, event: RunEvent)  — append + per-event hook
//   "run:end"       (run: Run)
//
// Run objects are mutated in-place. Subscribers that need stable snapshots
// should call snapshotRun().

export type RunStatus = "starting" | "running" | "done" | "failed" | "aborted";

export interface RunUsage {
	turns: number;
	input: number;
	output: number;
	cost: number;
}

export type RunEvent =
	| { type: "tool_call"; at: number; tool: string }
	| { type: "assistant_text"; at: number; text: string }
	| { type: "thinking"; at: number; text: string }
	| { type: "usage"; at: number; usage: RunUsage }
	| { type: "stderr"; at: number; line: string };

export interface Run {
	id: string;
	parentRunId?: string;
	task: string;
	parentDepth: number;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	events: RunEvent[];
	usage: RunUsage;
	lastAssistantText: string;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	piCommand?: string;
	pid?: number;
	abort: AbortController;
}

export interface StartOptions {
	task: string;
	parentDepth: number;
	parentRunId?: string;
	piCommand?: string;
}

const MAX_EVENTS_PER_RUN = 5_000;

export interface RegistryEvents {
	on(event: "run:start", handler: (run: Run) => void): void;
	on(event: "run:progress", handler: (run: Run, ev: RunEvent) => void): void;
	on(event: "run:end", handler: (run: Run) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const runs = new Map<string, Run>();

export function startRun(opts: StartOptions): Run {
	const run: Run = {
		id: randomUUID(),
		parentRunId: opts.parentRunId,
		task: opts.task,
		parentDepth: opts.parentDepth,
		status: "starting",
		startedAt: Date.now(),
		events: [],
		usage: { turns: 0, input: 0, output: 0, cost: 0 },
		lastAssistantText: "",
		piCommand: opts.piCommand,
		abort: new AbortController(),
	};
	runs.set(run.id, run);
	emitter.emit("run:start", run);
	return run;
}

export function markRunning(runId: string, pid: number | undefined): void {
	const run = runs.get(runId);
	if (!run) return;
	run.status = "running";
	run.pid = pid;
}

export function appendEvent(runId: string, ev: RunEvent): void {
	const run = runs.get(runId);
	if (!run) return;
	run.events.push(ev);
	if (run.events.length > MAX_EVENTS_PER_RUN) {
		run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
	}

	if (ev.type === "assistant_text") {
		run.lastAssistantText = ev.text;
	}
	if (ev.type === "usage") {
		run.usage = ev.usage;
	}

	emitter.emit("run:progress", run, ev);
}

export interface FinishOptions {
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	pid?: number;
}

export function finishRun(runId: string, opts: FinishOptions): void {
	const run = runs.get(runId);
	if (!run) return;
	run.exitCode = opts.exitCode;
	run.stopReason = opts.stopReason;
	run.errorMessage = opts.errorMessage;
	if (opts.pid !== undefined) run.pid = opts.pid;
	run.endedAt = Date.now();
	if (run.status === "aborted") {
		// already set by abortRun()
	} else if (opts.stopReason === "aborted") {
		run.status = "aborted";
	} else if (opts.exitCode !== 0 || opts.stopReason === "error") {
		run.status = "failed";
	} else {
		run.status = "done";
	}
	emitter.emit("run:end", run);
}

export interface ListFilter {
	status?: RunStatus | RunStatus[];
	parentRunId?: string;
	since?: number;
}

export function listRuns(filter: ListFilter = {}): Run[] {
	const statuses = filter.status === undefined
		? undefined
		: Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status]);

	const out: Run[] = [];
	for (const run of runs.values()) {
		if (statuses && !statuses.has(run.status)) continue;
		if (filter.parentRunId !== undefined && run.parentRunId !== filter.parentRunId) continue;
		if (filter.since !== undefined && run.startedAt < filter.since) continue;
		out.push(run);
	}
	out.sort((a, b) => a.startedAt - b.startedAt);
	return out;
}

export function getRun(runId: string): Run | undefined {
	return runs.get(runId);
}

export function abortRun(runId: string): boolean {
	const run = runs.get(runId);
	if (!run) return false;
	if (run.status === "done" || run.status === "failed" || run.status === "aborted") return false;
	run.status = "aborted";
	run.abort.abort();
	return true;
}

// Optional housekeeping for very long-lived pi sessions. Removes terminated
// runs older than `olderThanMs`. Returns the number cleared.
export function pruneRuns(olderThanMs: number): number {
	const cutoff = Date.now() - olderThanMs;
	let cleared = 0;
	for (const [id, run] of runs) {
		if (run.endedAt && run.endedAt < cutoff) {
			runs.delete(id);
			cleared++;
		}
	}
	return cleared;
}

// Stable JSON-safe snapshot (drops AbortController). Use when handing a Run
// to code that may serialize it or hold it across mutations.
export interface RunSnapshot extends Omit<Run, "abort"> {
	durationMs: number;
}

export function snapshotRun(run: Run): RunSnapshot {
	const { abort: _abort, ...rest } = run;
	return {
		...rest,
		events: [...run.events],
		usage: { ...run.usage },
		durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
	};
}

export const events: RegistryEvents = {
	on: (event, handler) => emitter.on(event, handler as (...args: unknown[]) => void),
	off: (event, handler) => emitter.off(event, handler),
};

// Test-only escape hatch for resetting state. Don't call in production code.
export function _resetRegistry(): void {
	runs.clear();
	emitter.removeAllListeners();
}
