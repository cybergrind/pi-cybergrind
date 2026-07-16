import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { SwitcherList } from "../extensions/lib/switcher-list.ts";
import { TOP_LEVEL, type SwitcherItem } from "../extensions/lib/switcher.ts";

function items(): SwitcherItem[] {
	return [
		{ value: TOP_LEVEL, label: "⌂ top-level (you)", detail: "", focused: true },
		{ value: "agent-a", label: "○ alpha · idle", detail: "did a thing", focused: false },
		{ value: "agent-b", label: "● bravo · busy", detail: "running tests", focused: false },
	];
}

interface Recorder {
	done: string[];
	close: string[];
	renders: number;
}

function makeList(itemsRef: { current: SwitcherItem[] }): { list: SwitcherList; rec: Recorder } {
	const rec: Recorder = { done: [], close: [], renders: 0 };
	const list = new SwitcherList(
		() => itemsRef.current,
		(v) => rec.done.push(v ?? "__cancel__"),
		(v) => rec.close.push(v),
		() => {
			rec.renders++;
		},
	);
	return { list, rec };
}

describe("SwitcherList", () => {
	test("enter on the initially focused row picks that value", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("\r");
		assert.deepEqual(rec.done, [TOP_LEVEL]);
	});

	test("down then enter advances the selection", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		assert.deepEqual(rec.done, ["agent-a"]);
	});

	test("up wraps from the first row", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		assert.deepEqual(rec.done, ["agent-b"]);
	});

	test("escape cancels with undefined", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("\x1b");
		assert.deepEqual(rec.done, ["__cancel__"]);
	});

	test("x closes the currently-selected agent and re-renders", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("\x1b[B"); // select agent-a
		list.handleInput("x");
		assert.deepEqual(rec.close, ["agent-a"]);
		assert.ok(rec.renders > 0);
		assert.equal(rec.done.length, 0, "overlay must stay open after close");
	});

	test("x on the top-level row is a no-op (cannot close yourself)", () => {
		const ref = { current: items() };
		const { list, rec } = makeList(ref);
		list.handleInput("x");
		assert.deepEqual(rec.close, []);
	});

	test("render clamps selection if the list shrank under it", () => {
		const ref = { current: items() };
		const { list } = makeList(ref);
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B"); // select agent-b
		ref.current = [items()[0]]; // pool emptied while overlay open
		const lines = list.render(80);
		assert.ok(lines.length > 0);
		list.handleInput("\r");
	});
});
