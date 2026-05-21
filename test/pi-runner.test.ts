import { describe, test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatHeader,
	formatRecentEvents,
	formatStats,
	formatTokens,
	isErrored,
	resolveOutput,
	resolvePiCommand,
	trimOneLine,
	type RunResult,
} from "../extensions/lib/pi-runner.ts";
import type { Run } from "../extensions/lib/run-registry.ts";

describe("formatTokens", () => {
	test("0–999 → integer string", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
	});
	test("1000–9999 → one-decimal kilo", () => {
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(9999), "10.0k");
	});
	test("≥10_000 → integer kilo", () => {
		assert.equal(formatTokens(10_000), "10k");
		assert.equal(formatTokens(123_456), "123k");
	});
});

describe("trimOneLine", () => {
	test("flattens whitespace", () => {
		assert.equal(trimOneLine("hello   world\n\tagain", 100), "hello world again");
	});
	test("truncates with ellipsis when over budget", () => {
		const out = trimOneLine("a".repeat(50), 10);
		assert.equal(out.length, 10);
		assert.ok(out.endsWith("…"));
	});
	test("leaves short text unchanged", () => {
		assert.equal(trimOneLine("short", 10), "short");
	});
});

describe("formatStats", () => {
	test("includes all stat segments", () => {
		const s = formatStats({ turns: 3, input: 1500, output: 800, cost: 0.0123 }, 2.5);
		assert.match(s, /^3 turns/);
		assert.ok(s.includes("↑1.5k"));
		assert.ok(s.includes("↓800"));
		assert.ok(s.includes("$0.0123"));
		assert.ok(s.includes("2.5s"));
	});
});

describe("isErrored", () => {
	const base: RunResult = {
		runId: "x",
		exitCode: 0,
		usage: { turns: 0, input: 0, output: 0, cost: 0 },
		finalText: "",
		stderr: "",
		took: 0,
		piCommand: "",
	};
	test("clean", () => assert.equal(isErrored({ ...base, stopReason: "stop" }), false));
	test("non-zero exit", () => assert.equal(isErrored({ ...base, exitCode: 1 }), true));
	test("stop=error", () => assert.equal(isErrored({ ...base, stopReason: "error" }), true));
	test("stop=aborted", () => assert.equal(isErrored({ ...base, stopReason: "aborted" }), true));
	test("stop=stop (normal)", () => assert.equal(isErrored({ ...base, stopReason: "stop" }), false));
});

describe("formatHeader", () => {
	const base: RunResult = {
		runId: "x",
		exitCode: 0,
		usage: { turns: 1, input: 100, output: 50, cost: 0.001 },
		finalText: "",
		stderr: "",
		took: 1.5,
		piCommand: "",
	};
	test("ok marker for successful run", () => {
		const h = formatHeader(base);
		assert.match(h, /✓/);
		assert.ok(!h.includes("✗"));
	});
	test("error marker + exit code + stopReason for failure", () => {
		const h = formatHeader({ ...base, exitCode: 2, stopReason: "error" });
		assert.match(h, /✗/);
		assert.ok(h.includes("exit=2"));
		assert.ok(h.includes("stop=error"));
	});
});

describe("resolveOutput", () => {
	test("uses finalText when present", () => {
		const r: RunResult = { runId: "", exitCode: 0, usage: { turns: 0, input: 0, output: 0, cost: 0 }, finalText: "hi", stderr: "", took: 0, piCommand: "" };
		assert.equal(resolveOutput(r), "hi");
	});
	test("falls back to errorMessage", () => {
		const r: RunResult = { runId: "", exitCode: 1, usage: { turns: 0, input: 0, output: 0, cost: 0 }, finalText: "", errorMessage: "boom", stderr: "noise", took: 0, piCommand: "" };
		assert.equal(resolveOutput(r), "boom");
	});
	test("falls back to stderr (trimmed)", () => {
		const r: RunResult = { runId: "", exitCode: 1, usage: { turns: 0, input: 0, output: 0, cost: 0 }, finalText: "", stderr: "  err\n", took: 0, piCommand: "" };
		assert.equal(resolveOutput(r), "err");
	});
	test("final fallback is the literal placeholder", () => {
		const r: RunResult = { runId: "", exitCode: 1, usage: { turns: 0, input: 0, output: 0, cost: 0 }, finalText: "", stderr: "", took: 0, piCommand: "" };
		assert.equal(resolveOutput(r), "(no output)");
	});
});

describe("formatRecentEvents", () => {
	const baseRun = (): Run => ({
		id: "x",
		task: "t",
		parentDepth: 0,
		status: "running",
		startedAt: 0,
		events: [],
		usage: { turns: 0, input: 0, output: 0, cost: 0 },
		lastAssistantText: "",
		abort: new AbortController(),
	});

	test("renders structured events as decorated lines", () => {
		const r = baseRun();
		r.events.push(
			{ type: "tool_call", at: 1, tool: "bash" },
			{ type: "assistant_text", at: 2, text: "hello world" },
			{ type: "stderr", at: 3, line: "warn x" },
		);
		const lines = formatRecentEvents(r, 10);
		assert.equal(lines.length, 3);
		assert.equal(lines[0], "🔧 bash");
		assert.ok(lines[1].startsWith("💬 "));
		assert.ok(lines[2].startsWith("⚠ "));
	});

	test("respects line cap, returning the most recent", () => {
		const r = baseRun();
		for (let i = 0; i < 30; i++) r.events.push({ type: "tool_call", at: i, tool: `t${i}` });
		const lines = formatRecentEvents(r, 5);
		assert.equal(lines.length, 5);
		assert.equal(lines[lines.length - 1], "🔧 t29");
	});

	test("skips usage and thinking events", () => {
		const r = baseRun();
		r.events.push(
			{ type: "usage", at: 1, usage: { turns: 1, input: 1, output: 1, cost: 0 } },
			{ type: "thinking", at: 2, text: "internal" },
			{ type: "tool_call", at: 3, tool: "ls" },
		);
		const lines = formatRecentEvents(r, 10);
		assert.deepEqual(lines, ["🔧 ls"]);
	});
});

describe("resolvePiCommand", () => {
	let tmpRoot: string;

	before(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-resolve-test-"));
	});
	after(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	test("PI_CMD override takes precedence", () => {
		const spec = resolvePiCommand({
			env: { PI_CMD: "/usr/bin/custom-pi --flag" },
			argv1: "/anything.js",
			cwd: tmpRoot,
		});
		assert.equal(spec.source, "PI_CMD");
		assert.equal(spec.command, "/usr/bin/custom-pi");
		assert.deepEqual(spec.prefixArgs, ["--flag"]);
	});

	test("PI_CMD tokenization handles quoted args", () => {
		const spec = resolvePiCommand({
			env: { PI_CMD: `/path/to/pi "arg with spaces" 'another arg'` },
			argv1: "/x.js",
			cwd: tmpRoot,
		});
		assert.equal(spec.command, "/path/to/pi");
		assert.deepEqual(spec.prefixArgs, ["arg with spaces", "another arg"]);
	});

	test("empty PI_CMD does NOT win (falls through)", () => {
		const spec = resolvePiCommand({
			env: { PI_CMD: "   " },
			argv1: undefined,
			cwd: tmpRoot,
		});
		assert.notEqual(spec.source, "PI_CMD");
	});

	test("argv1 wins when it's a real .js file", () => {
		const fakeCli = join(tmpRoot, "fake-pi.js");
		writeFileSync(fakeCli, "// pi cli stub");
		const spec = resolvePiCommand({
			env: {},
			argv1: fakeCli,
			cwd: tmpRoot,
			execPath: "/usr/bin/node",
		});
		assert.equal(spec.source, "argv1");
		assert.equal(spec.command, "/usr/bin/node");
		assert.deepEqual(spec.prefixArgs, [fakeCli]);
	});

	test("argv1 with .ts extension is rejected (not a JS-runnable)", () => {
		const fakeCli = join(tmpRoot, "fake-pi.ts");
		writeFileSync(fakeCli, "// ts source");
		const spec = resolvePiCommand({
			env: {},
			argv1: fakeCli,
			cwd: tmpRoot,
		});
		assert.notEqual(spec.source, "argv1");
	});

	test("package-bin discovered when cwd has node_modules layout", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "pi-pkg-test-"));
		try {
			const pkgDir = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
			mkdirSync(pkgDir, { recursive: true });
			const binPath = join(pkgDir, "dist", "cli.js");
			mkdirSync(join(pkgDir, "dist"), { recursive: true });
			writeFileSync(binPath, "// pi cli\n");
			chmodSync(binPath, 0o755);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
			);

			const spec = resolvePiCommand({
				env: {},
				argv1: undefined,
				cwd: projectRoot,
				execPath: "/usr/bin/node",
			});
			assert.equal(spec.source, "package-bin");
			assert.equal(spec.command, "/usr/bin/node");
			assert.equal(spec.prefixArgs.length, 1);
			assert.ok(spec.prefixArgs[0].endsWith("cli.js"));
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("falls back to 'pi' on PATH when nothing else resolves", () => {
		const isolated = mkdtempSync(join(tmpdir(), "pi-empty-test-"));
		try {
			// argv1: "" explicitly — undefined would default to process.argv[1],
			// which under `node --test` walks up into THIS project's node_modules
			// and finds @earendil-works/pi-coding-agent, defeating the test.
			const spec = resolvePiCommand({
				env: {},
				argv1: "",
				cwd: isolated,
			});
			assert.equal(spec.source, "path-fallback");
			assert.equal(spec.command, "pi");
			assert.deepEqual(spec.prefixArgs, []);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});
