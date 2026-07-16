import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	TOP_LEVEL,
	buildSwitcherItems,
	formatFocusWidget,
	shouldActivate,
	statusGlyph,
} from "../extensions/lib/switcher.ts";
import type { InteractiveAgent } from "../extensions/lib/agent-pool.ts";

function agent(over: Partial<InteractiveAgent>): InteractiveAgent {
	return {
		id: "id1",
		name: "builder",
		task: "build it",
		status: "idle",
		createdAt: 0,
		lastText: "",
		turns: 0,
		...over,
	};
}

describe("shouldActivate", () => {
	test("active at the top level", () => {
		assert.equal(shouldActivate({}), true);
	});
	test("inactive inside a nested subagent (depth set)", () => {
		assert.equal(shouldActivate({ PI_SUBAGENT_DEPTH: "1" }), false);
	});
	test("inactive inside an interactive subagent", () => {
		assert.equal(shouldActivate({ PI_INTERACTIVE_SUBAGENT: "1" }), false);
	});
	test("depth of 0 is still the top level", () => {
		assert.equal(shouldActivate({ PI_SUBAGENT_DEPTH: "0" }), true);
	});
});

describe("statusGlyph", () => {
	test("distinct glyphs per status", () => {
		const glyphs = new Set(
			(["starting", "idle", "busy", "stopped", "error"] as const).map((s) => statusGlyph(s)),
		);
		assert.equal(glyphs.size, 5);
	});
});

describe("buildSwitcherItems", () => {
	test("always leads with a top-level entry", () => {
		const items = buildSwitcherItems([], null);
		assert.equal(items.length, 1);
		assert.equal(items[0].value, TOP_LEVEL);
	});

	test("marks the focused entry (top-level when focus is null)", () => {
		const items = buildSwitcherItems([agent({ id: "a" })], null);
		assert.equal(items[0].focused, true);
		assert.equal(items[1].focused, false);
	});

	test("marks the focused agent", () => {
		const items = buildSwitcherItems([agent({ id: "a" }), agent({ id: "b", name: "tester" })], "b");
		assert.equal(items.find((i) => i.value === "b")?.focused, true);
		assert.equal(items.find((i) => i.value === TOP_LEVEL)?.focused, false);
	});

	test("agent label carries name and status; detail carries last text", () => {
		const items = buildSwitcherItems([agent({ id: "a", name: "builder", status: "busy", lastText: "running tests now" })], null);
		const item = items.find((i) => i.value === "a")!;
		assert.match(item.label, /builder/);
		assert.match(item.label, /busy/);
		assert.match(item.detail, /running tests/);
	});
});

describe("formatFocusWidget", () => {
	test("returns undefined when on top-level (nothing to show)", () => {
		assert.equal(formatFocusWidget(null), undefined);
	});
	test("names the focused agent and hints at interrupt while busy", () => {
		const lines = formatFocusWidget(agent({ name: "builder", status: "busy" }));
		assert.ok(Array.isArray(lines));
		assert.match(lines!.join(" "), /builder/);
		assert.match(lines!.join(" ").toLowerCase(), /interrupt/);
	});
	test("hints at leaving focus while idle", () => {
		const lines = formatFocusWidget(agent({ name: "builder", status: "idle" }));
		assert.match(lines!.join(" ").toLowerCase(), /leave|top/);
	});
});
