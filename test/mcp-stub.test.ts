import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGatedMcpExtension, MCP_COMMAND, stubNotice, type McpCommandSpec } from "../extensions/mcp.ts";
import { shouldLoadMcp } from "../extensions/lib/mcp-gate.ts";

// Fake pi: records registerCommand calls into a Map (same replace-on-rewrite
// semantics as pi's loader) and exposes an unrelated method to prove the proxy
// passes other members through.
function fakePi() {
	const commands = new Map<string, McpCommandSpec>();
	const pi = {
		registerCommand(name: string, options: McpCommandSpec) {
			commands.set(name, options);
		},
		getAllTools() {
			return [];
		},
	};
	return { pi: pi as unknown as ExtensionAPI, commands };
}

function fakeCtx(hasUI = true) {
	const notices: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI,
		ui: {
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionCommandContext, notices };
}

// Fake adapter: registers its own `/mcp` like pi-mcp-adapter does and records
// what it was invoked with.
function fakeAdapter() {
	let installs = 0;
	const forwarded: string[] = [];
	const installer = async (pi: ExtensionAPI) => {
		installs++;
		pi.registerCommand(MCP_COMMAND, {
			description: "adapter",
			handler: async (args) => {
				forwarded.push(args);
			},
		});
	};
	return { installer, forwarded, get installs() { return installs; } };
}

describe("gated-off /mcp stub", () => {
	const emptyDir = () => mkdtempSync(join(tmpdir(), "mcp-stub-"));

	test("stub is registered only when the gate is off", async () => {
		const dir = emptyDir();
		try {
			const off = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: {} })(off.pi);
			assert.equal(adapter.installs, 0);
			assert.ok(off.commands.has(MCP_COMMAND), "stub /mcp registered");
			assert.match(off.commands.get(MCP_COMMAND)?.description ?? "", /off/);

			writeFileSync(join(dir, ".mcp.json"), "{}");
			const on = fakePi();
			const adapter2 = fakeAdapter();
			await createGatedMcpExtension(adapter2.installer, { cwd: dir, env: {} })(on.pi);
			assert.equal(adapter2.installs, 1);
			assert.equal(on.commands.get(MCP_COMMAND)?.description, "adapter", "gated-on: adapter owns /mcp, no stub");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no args / status → notice via ctx.ui, adapter not loaded", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx, notices } = fakeCtx();
			await stub.handler("", ctx);
			await stub.handler("status", ctx);
			assert.equal(adapter.installs, 0);
			assert.equal(notices.length, 2);
			assert.match(notices[0].message, /MCP is off/);
			assert.match(notices[0].message, /\.mcp\.json/);
			assert.match(notices[0].message, /PI_MCP=on/);
			assert.match(notices[0].message, /\/mcp setup/);
			assert.ok(notices[0].message.includes(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PI_MCP=off notice names the override and still allows load", async () => {
		const dir = emptyDir();
		try {
			writeFileSync(join(dir, ".mcp.json"), "{}");
			const { pi, commands } = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: { PI_MCP: "off" } })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx, notices } = fakeCtx();
			await stub.handler("", ctx);
			assert.match(notices[0].message, /PI_MCP=off is set/);
			await stub.handler("load", ctx);
			assert.equal(adapter.installs, 1);
			const notice = stubNotice(shouldLoadMcp({ cwd: dir, env: { PI_MCP: "off" } }), dir);
			assert.match(notice, /PI_MCP=off is set/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("load installs once; second load does not re-install; adapter now owns /mcp", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx, notices } = fakeCtx();
			await stub.handler("load", ctx);
			await stub.handler("load", ctx);
			assert.equal(adapter.installs, 1);
			assert.equal(adapter.forwarded.length, 0, "load does not forward to the adapter handler");
			assert.match(notices[0].message, /loaded/);
			assert.equal(commands.get(MCP_COMMAND)?.description, "adapter", "adapter registration replaced the stub");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("setup (or any other args) installs then forwards the args to the adapter handler", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx } = fakeCtx();
			await stub.handler("setup", ctx);
			await stub.handler("add foo --url http://x", ctx);
			assert.equal(adapter.installs, 1);
			assert.deepEqual(adapter.forwarded, ["setup", "add foo --url http://x"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("concurrent load and setup install once", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			const adapter = fakeAdapter();
			await createGatedMcpExtension(adapter.installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx } = fakeCtx();
			await Promise.all([stub.handler("load", ctx), stub.handler("setup", ctx)]);
			assert.equal(adapter.installs, 1);
			assert.deepEqual(adapter.forwarded, ["setup"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("adapter that registers no /mcp → error notice, no throw", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			let installs = 0;
			await createGatedMcpExtension(async () => { installs++; }, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx, notices } = fakeCtx();
			await stub.handler("setup", ctx);
			assert.equal(installs, 1);
			assert.equal(notices[0].type, "error");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without UI the notice goes to stderr, not ctx.ui", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			await createGatedMcpExtension(fakeAdapter().installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const { ctx, notices } = fakeCtx(false);
			const chunks: string[] = [];
			const orig = process.stderr.write.bind(process.stderr);
			(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
				chunks.push(String(s));
				return true;
			};
			try {
				await stub.handler("", ctx);
			} finally {
				process.stderr.write = orig;
			}
			assert.equal(notices.length, 0);
			assert.ok(chunks.some((c) => c.includes("MCP is off")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("argument completions list the stub subcommands", async () => {
		const dir = emptyDir();
		try {
			const { pi, commands } = fakePi();
			await createGatedMcpExtension(fakeAdapter().installer, { cwd: dir, env: {} })(pi);
			const stub = commands.get(MCP_COMMAND)!;
			const all = await stub.getArgumentCompletions!("");
			assert.deepEqual((all ?? []).map((i) => i.value).sort(), ["load", "setup", "status"]);
			const s = await stub.getArgumentCompletions!("se");
			assert.deepEqual((s ?? []).map((i) => i.value), ["setup"]);
			assert.equal(await stub.getArgumentCompletions!("setup x"), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
