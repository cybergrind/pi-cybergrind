import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { FocusRouter } from "../extensions/lib/focus-router.ts";

describe("FocusRouter", () => {
	test("starts focused on top-level (null)", () => {
		const r = new FocusRouter();
		assert.equal(r.current(), null);
		assert.equal(r.isFocused(), false);
	});

	test("focus(id) moves focus to an agent", () => {
		const r = new FocusRouter();
		r.focus("a");
		assert.equal(r.current(), "a");
		assert.equal(r.isFocused(), true);
	});

	test("focus(null) returns to top-level", () => {
		const r = new FocusRouter();
		r.focus("a");
		r.focus(null);
		assert.equal(r.current(), null);
		assert.equal(r.isFocused(), false);
	});

	test("reconcile clears focus when the focused agent is gone", () => {
		const r = new FocusRouter();
		r.focus("a");
		const cleared = r.reconcile(["b", "c"]);
		assert.equal(cleared, true);
		assert.equal(r.current(), null);
	});

	test("reconcile keeps focus when the focused agent is still present", () => {
		const r = new FocusRouter();
		r.focus("a");
		const cleared = r.reconcile(["a", "b"]);
		assert.equal(cleared, false);
		assert.equal(r.current(), "a");
	});

	test("reconcile is a no-op while on top-level", () => {
		const r = new FocusRouter();
		const cleared = r.reconcile([]);
		assert.equal(cleared, false);
		assert.equal(r.current(), null);
	});
});
