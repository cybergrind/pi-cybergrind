import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_VAR, PROJECT_CONFIG_FILES, shouldLoadMcp } from "../extensions/lib/mcp-gate.ts";
import { createGatedMcpExtension } from "../extensions/mcp.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("shouldLoadMcp", () => {
	test("constants", () => {
		assert.deepEqual(PROJECT_CONFIG_FILES, [".mcp.json", ".pi/mcp.json"]);
		assert.equal(ENV_VAR, "PI_MCP");
	});

	test("empty dir → do not load", () => {
		withTempDir((dir) => {
			const d = shouldLoadMcp({ cwd: dir, env: {} });
			assert.equal(d.load, false);
			assert.match(d.reason, /no project/i);
			assert.deepEqual(d.sources, []);
			assert.equal(d.warning, undefined);
		});
	});

	test(".mcp.json present → load", () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, ".mcp.json"), '{"mcpServers":{}}');
			const d = shouldLoadMcp({ cwd: dir, env: {} });
			assert.equal(d.load, true);
			assert.deepEqual(d.sources, [".mcp.json"]);
		});
	});

	test("only .pi/mcp.json present → load", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi/mcp.json"), "{}");
			const d = shouldLoadMcp({ cwd: dir, env: {} });
			assert.equal(d.load, true);
			assert.deepEqual(d.sources, [".pi/mcp.json"]);
		});
	});

	test("both present → both listed", () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, ".mcp.json"), "{}");
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi/mcp.json"), "{}");
			const d = shouldLoadMcp({ cwd: dir, env: {} });
			assert.equal(d.load, true);
			assert.deepEqual(d.sources, [".mcp.json", ".pi/mcp.json"]);
		});
	});

	test("a directory named .mcp.json does not count", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, ".mcp.json"));
			const d = shouldLoadMcp({ cwd: dir, env: {} });
			assert.equal(d.load, false);
		});
	});

	test("PI_MCP=off overrides a present config", () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, ".mcp.json"), "{}");
			for (const v of ["off", "0", "OFF", "false"]) {
				const d = shouldLoadMcp({ cwd: dir, env: { PI_MCP: v } });
				assert.equal(d.load, false, v);
				assert.match(d.reason, /PI_MCP/);
			}
		});
	});

	test("PI_MCP=on forces load in an empty dir", () => {
		withTempDir((dir) => {
			for (const v of ["on", "1", "ON", "true"]) {
				const d = shouldLoadMcp({ cwd: dir, env: { PI_MCP: v } });
				assert.equal(d.load, true, v);
				assert.match(d.reason, /PI_MCP/);
				assert.deepEqual(d.sources, []);
			}
		});
	});

	test("PI_MCP=garbage → auto with a warning", () => {
		withTempDir((dir) => {
			const off = shouldLoadMcp({ cwd: dir, env: { PI_MCP: "garbage" } });
			assert.equal(off.load, false);
			assert.match(off.warning ?? "", /garbage/);
			writeFileSync(join(dir, ".mcp.json"), "{}");
			const on = shouldLoadMcp({ cwd: dir, env: { PI_MCP: "garbage" } });
			assert.equal(on.load, true);
			assert.match(on.warning ?? "", /garbage/);
		});
	});

	test("empty PI_MCP is treated as unset", () => {
		withTempDir((dir) => {
			const d = shouldLoadMcp({ cwd: dir, env: { PI_MCP: "  " } });
			assert.equal(d.load, false);
			assert.equal(d.warning, undefined);
		});
	});
});

describe("createGatedMcpExtension", () => {
	const registered: string[] = [];
	const fakePi = { registerCommand: (name: string) => registered.push(name) } as never;

	test("installer runs exactly once when the gate passes", async () => {
		await new Promise<void>((resolve, reject) => {
			withTempDir((dir) => {
				writeFileSync(join(dir, ".mcp.json"), "{}");
				let calls = 0;
				const ext = createGatedMcpExtension(async (pi) => {
					calls++;
					assert.equal(pi, fakePi);
				}, { cwd: dir, env: {} });
				Promise.resolve(ext(fakePi))
					.then(() => {
						assert.equal(calls, 1);
						resolve();
					})
					.catch(reject);
			});
		});
	});

	test("installer is not called when the gate fails", async () => {
		let calls = 0;
		let ext: ReturnType<typeof createGatedMcpExtension> | undefined;
		withTempDir((dir) => {
			ext = createGatedMcpExtension(async () => {
				calls++;
			}, { cwd: dir, env: {} });
		});
		registered.length = 0;
		await ext!(fakePi);
		assert.equal(calls, 0);
		assert.deepEqual(registered, ["mcp"], "gated-off session registers only the /mcp stub");
	});

	test("installer errors propagate", async () => {
		let ext: ReturnType<typeof createGatedMcpExtension> | undefined;
		const dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
		try {
			writeFileSync(join(dir, ".mcp.json"), "{}");
			ext = createGatedMcpExtension(async () => {
				throw new Error("boom");
			}, { cwd: dir, env: {} });
			await assert.rejects(() => ext!(fakePi), /boom/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PI_MCP=on with no config still installs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
		try {
			let calls = 0;
			const ext = createGatedMcpExtension(async () => {
				calls++;
			}, { cwd: dir, env: { PI_MCP: "on" } });
			await ext(fakePi);
			assert.equal(calls, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
