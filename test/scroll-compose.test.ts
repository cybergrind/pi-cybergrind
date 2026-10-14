import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkspace, ENV_DIR, waitForExit, workspaceBase } from "../extensions/lib/scroll-compose.ts";

function withDir(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "scroll-compose-test-"));
		try {
			await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

const FAST = { startupMs: 300, pollMs: 20 };

describe("scroll-compose workspace", () => {
	// pi may run with a private /tmp (sbox → firejail --private-tmp) while nvim
	// is started by the tmux server outside it, so the files they share must
	// not live in the OS temp dir.
	test("defaults to the pi agent dir, not the OS temp dir", () => {
		const base = workspaceBase({}, "/home/u/.pi/agent");
		assert.equal(base, "/home/u/.pi/agent/scroll-compose");
		assert.ok(!base.startsWith(tmpdir()));
	});

	test(`${ENV_DIR} overrides the location`, () => {
		assert.equal(workspaceBase({ [ENV_DIR]: "/x/y" }, "/home/u/.pi/agent"), "/x/y");
	});

	test(
		"is created under the base dir (made if missing) and cleaned up",
		withDir((dir) => {
			const base = join(dir, "agent", "scroll-compose");
			const ws = createWorkspace(base);
			assert.equal(dirname(dirname(ws.tmpfile)), base);
			assert.match(ws.tmpfile, /pi-scroll-compose-[^/]+\/input\.txt$/);
			for (const f of [ws.sentinel, ws.pidfile, ws.initLua]) assert.equal(dirname(f), dirname(ws.tmpfile));
			assert.ok(existsSync(dirname(ws.tmpfile)));
			ws.cleanup();
			assert.ok(!existsSync(dirname(ws.tmpfile)));
		}),
	);
});

describe("waitForExit", () => {
	test(
		"sentinel → clean",
		withDir(async (dir) => {
			writeFileSync(join(dir, "done"), "done\n");
			assert.equal(await waitForExit(join(dir, "done"), join(dir, "nvim.pid"), FAST), "clean");
		}),
	);

	// The bug: nvim never saw our files (no pidfile, no sentinel) and the
	// loop polled forever, leaving every later Ctrl+U at "already open".
	test(
		"neither pidfile nor sentinel ever appears → lost, without hanging",
		withDir(async (dir) => {
			const started = Date.now();
			assert.equal(await waitForExit(join(dir, "done"), join(dir, "nvim.pid"), FAST), "lost");
			assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
		}),
	);

	test(
		"pidfile of a dead process and no sentinel → killed",
		withDir(async (dir) => {
			const child = spawn("true");
			await new Promise((r) => child.on("exit", r));
			writeFileSync(join(dir, "nvim.pid"), `${child.pid}\n`);
			assert.equal(await waitForExit(join(dir, "done"), join(dir, "nvim.pid"), FAST), "killed");
		}),
	);

	test(
		"live process keeps it waiting past the startup window until the sentinel appears",
		withDir(async (dir) => {
			const child = spawn("sleep", ["5"]);
			try {
				writeFileSync(join(dir, "nvim.pid"), `${child.pid}\n`);
				setTimeout(() => writeFileSync(join(dir, "done"), "done\n"), FAST.startupMs * 2);
				assert.equal(await waitForExit(join(dir, "done"), join(dir, "nvim.pid"), FAST), "clean");
			} finally {
				child.kill("SIGKILL");
			}
		}),
	);
});
