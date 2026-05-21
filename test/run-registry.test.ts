import { describe, test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
	_resetRegistry,
	abortRun,
	appendEvent,
	events,
	finishRun,
	getRun,
	listRuns,
	markRunning,
	pruneRuns,
	snapshotRun,
	startRun,
	type Run,
	type RunEvent,
} from "../extensions/lib/run-registry.ts";

beforeEach(() => {
	_resetRegistry();
});

describe("startRun", () => {
	test("creates a run with starting status and unique id", () => {
		const a = startRun({ task: "x", parentDepth: 0 });
		const b = startRun({ task: "y", parentDepth: 0 });
		assert.notEqual(a.id, b.id);
		assert.equal(a.status, "starting");
		assert.equal(a.task, "x");
		assert.equal(a.parentDepth, 0);
		assert.deepEqual(a.usage, { turns: 0, input: 0, output: 0, cost: 0 });
		assert.equal(a.lastAssistantText, "");
		assert.equal(a.events.length, 0);
		assert.ok(a.abort instanceof AbortController);
	});

	test("emits run:start exactly once with the new run", () => {
		const seen: Run[] = [];
		events.on("run:start", (run) => seen.push(run));
		const run = startRun({ task: "x", parentDepth: 0 });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].id, run.id);
	});

	test("propagates parentRunId and piCommand", () => {
		const run = startRun({ task: "x", parentDepth: 1, parentRunId: "parent-id", piCommand: "PI_CMD: pi" });
		assert.equal(run.parentRunId, "parent-id");
		assert.equal(run.piCommand, "PI_CMD: pi");
		assert.equal(run.parentDepth, 1);
	});
});

describe("markRunning", () => {
	test("transitions starting → running and sets pid", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 12345);
		assert.equal(run.status, "running");
		assert.equal(run.pid, 12345);
	});

	test("noop on unknown id", () => {
		assert.doesNotThrow(() => markRunning("nope", 1));
	});
});

describe("appendEvent", () => {
	test("appends and emits run:progress", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		const seen: RunEvent[] = [];
		events.on("run:progress", (_r, ev) => seen.push(ev));
		appendEvent(run.id, { type: "tool_call", at: 1, tool: "bash" });
		assert.equal(run.events.length, 1);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].type, "tool_call");
	});

	test("updates lastAssistantText for assistant_text events", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		appendEvent(run.id, { type: "assistant_text", at: 1, text: "first" });
		appendEvent(run.id, { type: "assistant_text", at: 2, text: "second" });
		assert.equal(run.lastAssistantText, "second");
	});

	test("replaces usage from usage events", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		appendEvent(run.id, { type: "usage", at: 1, usage: { turns: 1, input: 10, output: 20, cost: 0.01 } });
		assert.deepEqual(run.usage, { turns: 1, input: 10, output: 20, cost: 0.01 });
		appendEvent(run.id, { type: "usage", at: 2, usage: { turns: 2, input: 30, output: 40, cost: 0.02 } });
		assert.deepEqual(run.usage, { turns: 2, input: 30, output: 40, cost: 0.02 });
	});

	test("caps events buffer to prevent unbounded growth", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		for (let i = 0; i < 6_000; i++) {
			appendEvent(run.id, { type: "stderr", at: i, line: `line ${i}` });
		}
		assert.ok(run.events.length <= 5_000, `expected ≤5000 events, got ${run.events.length}`);
		// Most recent entries kept (FIFO eviction).
		assert.ok((run.events[run.events.length - 1] as RunEvent).type === "stderr");
		assert.equal((run.events[run.events.length - 1] as { line: string }).line, "line 5999");
	});

	test("noop on unknown id (no throw, no emit)", () => {
		let emitted = 0;
		events.on("run:progress", () => emitted++);
		appendEvent("nope", { type: "tool_call", at: 1, tool: "bash" });
		assert.equal(emitted, 0);
	});
});

describe("finishRun", () => {
	test("exit 0 + no stopReason → done", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 1);
		finishRun(run.id, { exitCode: 0 });
		assert.equal(run.status, "done");
		assert.ok(run.endedAt);
	});

	test("exit !=0 → failed", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		finishRun(run.id, { exitCode: 1 });
		assert.equal(run.status, "failed");
	});

	test("stopReason 'error' → failed even on exit 0", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		finishRun(run.id, { exitCode: 0, stopReason: "error" });
		assert.equal(run.status, "failed");
	});

	test("stopReason 'aborted' → aborted", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		finishRun(run.id, { exitCode: 0, stopReason: "aborted" });
		assert.equal(run.status, "aborted");
	});

	test("preserves aborted status if abortRun set it first", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 1);
		abortRun(run.id);
		assert.equal(run.status, "aborted");
		finishRun(run.id, { exitCode: 0 });
		assert.equal(run.status, "aborted");
	});

	test("emits run:end exactly once", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		let endCount = 0;
		events.on("run:end", () => endCount++);
		finishRun(run.id, { exitCode: 0 });
		assert.equal(endCount, 1);
	});
});

describe("listRuns / getRun", () => {
	test("returns runs sorted by startedAt", async () => {
		const a = startRun({ task: "a", parentDepth: 0 });
		await new Promise((r) => setTimeout(r, 5));
		const b = startRun({ task: "b", parentDepth: 0 });
		const all = listRuns();
		assert.equal(all.length, 2);
		assert.equal(all[0].id, a.id);
		assert.equal(all[1].id, b.id);
	});

	test("filter by single status", () => {
		const a = startRun({ task: "a", parentDepth: 0 });
		const b = startRun({ task: "b", parentDepth: 0 });
		finishRun(a.id, { exitCode: 0 });
		assert.deepEqual(listRuns({ status: "starting" }).map((r) => r.id), [b.id]);
		assert.deepEqual(listRuns({ status: "done" }).map((r) => r.id), [a.id]);
	});

	test("filter by status array", () => {
		const a = startRun({ task: "a", parentDepth: 0 });
		const b = startRun({ task: "b", parentDepth: 0 });
		const c = startRun({ task: "c", parentDepth: 0 });
		finishRun(a.id, { exitCode: 0 });
		finishRun(b.id, { exitCode: 1 });
		const got = listRuns({ status: ["done", "failed"] }).map((r) => r.id).sort();
		assert.deepEqual(got, [a.id, b.id].sort());
		assert.deepEqual(listRuns({ status: ["starting"] }).map((r) => r.id), [c.id]);
	});

	test("filter by parentRunId", () => {
		const parent = startRun({ task: "p", parentDepth: 0 });
		const child = startRun({ task: "c", parentDepth: 1, parentRunId: parent.id });
		startRun({ task: "unrelated", parentDepth: 0 });
		const got = listRuns({ parentRunId: parent.id });
		assert.deepEqual(got.map((r) => r.id), [child.id]);
	});

	test("filter by since", async () => {
		startRun({ task: "old", parentDepth: 0 });
		await new Promise((r) => setTimeout(r, 10));
		const cutoff = Date.now();
		await new Promise((r) => setTimeout(r, 5));
		const newer = startRun({ task: "new", parentDepth: 0 });
		const got = listRuns({ since: cutoff });
		assert.deepEqual(got.map((r) => r.id), [newer.id]);
	});

	test("getRun returns undefined for unknown id", () => {
		assert.equal(getRun("nope"), undefined);
	});
});

describe("abortRun", () => {
	test("returns true for live run, sets status to aborted, signals abort", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 1);
		let signaled = false;
		run.abort.signal.addEventListener("abort", () => {
			signaled = true;
		});
		const ok = abortRun(run.id);
		assert.equal(ok, true);
		assert.equal(run.status, "aborted");
		assert.equal(signaled, true);
	});

	test("returns false for terminal run", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		finishRun(run.id, { exitCode: 0 });
		assert.equal(abortRun(run.id), false);
	});

	test("returns false for unknown id", () => {
		assert.equal(abortRun("nope"), false);
	});
});

describe("snapshotRun", () => {
	test("excludes AbortController and adds durationMs", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 1);
		finishRun(run.id, { exitCode: 0 });
		const snap = snapshotRun(run);
		assert.equal("abort" in snap, false);
		assert.ok(typeof snap.durationMs === "number");
		assert.ok(snap.durationMs >= 0);
		assert.doesNotThrow(() => JSON.stringify(snap));
	});

	test("durationMs for in-flight runs uses Date.now()", async () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		markRunning(run.id, 1);
		await new Promise((r) => setTimeout(r, 10));
		const snap = snapshotRun(run);
		assert.ok(snap.durationMs >= 10);
	});

	test("event array is a copy (not live reference)", () => {
		const run = startRun({ task: "x", parentDepth: 0 });
		appendEvent(run.id, { type: "tool_call", at: 1, tool: "a" });
		const snap = snapshotRun(run);
		assert.equal(snap.events.length, 1);
		appendEvent(run.id, { type: "tool_call", at: 2, tool: "b" });
		assert.equal(snap.events.length, 1, "snapshot should not see mutations after capture");
	});
});

describe("pruneRuns", () => {
	test("removes only terminal runs older than cutoff", () => {
		const oldDone = startRun({ task: "old-done", parentDepth: 0 });
		finishRun(oldDone.id, { exitCode: 0 });
		oldDone.endedAt = Date.now() - 60_000;

		const oldLive = startRun({ task: "old-live", parentDepth: 0 });
		oldLive.startedAt = Date.now() - 60_000;

		const newDone = startRun({ task: "new-done", parentDepth: 0 });
		finishRun(newDone.id, { exitCode: 0 });

		const cleared = pruneRuns(30_000);
		assert.equal(cleared, 1);
		assert.equal(getRun(oldDone.id), undefined);
		assert.ok(getRun(oldLive.id), "live runs must survive prune");
		assert.ok(getRun(newDone.id), "recent runs must survive prune");
	});
});
