// Smoke test for the gated pi-mcp-adapter wrapper against a real MCP server.
//
// Run with:
//   PI_CMD=/path/to/pi-test.sh npm run test:mcp
//
// Requires a Binary Ninja UI MCP server (streamable HTTP, no auth) at
// BINJA_MCP_URL (default http://127.0.0.1:24642/mcp). If it is unreachable the
// test prints a SKIP line and exits with code 2 (distinct from pass 0 / fail 1)
// so the gap is visible in test:all rather than silently passing.
//
// Runs (each a headless `pi -p --mode json --no-session --no-extensions` with
// only extensions/mcp.ts and the probe fixture loaded):
//   A  empty project dir            → adapter must NOT load (no `mcp` tool),
//                                     but the gated-off `/mcp` stub command exists
//   B  project dir with .mcp.json   → adapter loads, model searches and calls
//                                     bn_binary_view_list through the proxy tool
//   C  empty project dir, PI_MCP=on → adapter loads with zero servers

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describePiSpawnSpec, resolvePiCommand } from "../extensions/lib/pi-runner.ts";
import { PROBE_PREFIX } from "./fixtures/mcp-probe.ts";

const TIMEOUT_MS = 120_000;
const BINJA_URL = process.env.BINJA_MCP_URL ?? "http://127.0.0.1:24642/mcp";
const LIST_TOOL = "bn_binary_view_list";

// npm scripts run from the repo root; PI_CYBERGRIND_ROOT overrides for ad-hoc runs.
const ROOT = resolve(process.env.PI_CYBERGRIND_ROOT ?? process.cwd());
const MCP_EXT = join(ROOT, "extensions/mcp.ts");
const PROBE_EXT = join(ROOT, "test/fixtures/mcp-probe.ts");

interface ToolStart {
	type: "tool_execution_start";
	toolName: string;
	args: Record<string, unknown>;
	toolCallId: string;
}
interface ToolEnd {
	type: "tool_execution_end";
	toolName: string;
	toolCallId: string;
	result: unknown;
	isError: boolean;
}
interface PiRun {
	exitCode: number;
	timedOut: boolean;
	tools: string[] | undefined;
	commands: string[] | undefined;
	starts: ToolStart[];
	ends: ToolEnd[];
	finalText: string;
	stderr: string;
}

function log(line: string): void {
	process.stderr.write(`[mcp-smoke] ${line}\n`);
}

async function probeServer(): Promise<string> {
	const res = await fetch(BINJA_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "pi-cybergrind-mcp-smoke", version: "0" },
			},
		}),
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
	const name = body.result?.serverInfo?.name;
	if (!name) throw new Error("initialize returned no serverInfo");
	return name;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function runPi(opts: { cwd: string; env?: Record<string, string>; prompt: string }): Promise<PiRun> {
	const spec = resolvePiCommand();
	const args = [
		...spec.prefixArgs,
		"-p",
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"-e",
		MCP_EXT,
		"-e",
		PROBE_EXT,
	];
	if (process.env.PI_MODEL) args.push("--model", process.env.PI_MODEL);
	args.push(opts.prompt);

	const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
	// Never inherit an ambient override from the caller's shell unless the run sets it.
	if (!opts.env || !("PI_MCP" in opts.env)) delete env.PI_MCP;

	return new Promise<PiRun>((resolvePromise) => {
		const run: PiRun = {
			exitCode: -1,
			timedOut: false,
			tools: undefined,
			commands: undefined,
			starts: [],
			ends: [],
			finalText: "",
			stderr: "",
		};
		const proc = spawn(spec.command, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			run.timedOut = true;
			proc.kill("SIGKILL");
		}, TIMEOUT_MS);

		let buffer = "";
		const consume = (line: string) => {
			if (!line.trim()) return;
			let evt: Record<string, unknown>;
			try {
				evt = JSON.parse(line);
			} catch {
				return;
			}
			if (evt.type === "tool_execution_start") run.starts.push(evt as unknown as ToolStart);
			else if (evt.type === "tool_execution_end") run.ends.push(evt as unknown as ToolEnd);
			else if (evt.type === "message_end") {
				const msg = evt.message as { role?: string; content?: unknown } | undefined;
				if (msg?.role === "assistant") {
					const text = extractText(msg.content);
					if (text) run.finalText = text;
				}
			}
		};
		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) consume(l);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			run.stderr += text;
			for (const l of text.split("\n")) {
				if (l.startsWith(PROBE_PREFIX)) {
					try {
						const probe = JSON.parse(l.slice(PROBE_PREFIX.length)) as { tools: string[]; commands?: string[] };
						run.tools = probe.tools;
						run.commands = probe.commands;
					} catch {
						/* malformed probe line — leave undefined, assertions will fail loudly */
					}
				}
			}
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) consume(buffer);
			run.exitCode = code ?? -1;
			resolvePromise(run);
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			run.stderr += `spawn error: ${err.message}\n`;
			resolvePromise(run);
		});
	});
}

class Failures {
	list: string[] = [];
	check(cond: boolean, msg: string): void {
		if (!cond) this.list.push(msg);
	}
}

function summarize(name: string, run: PiRun): void {
	log(`${name}: exit=${run.exitCode} timedOut=${run.timedOut} tools=${run.tools ? run.tools.length : "?"} ` +
		`toolCalls=${run.starts.length} final="${run.finalText.slice(0, 80).replace(/\s+/g, " ")}"`);
}

function stderrTail(run: PiRun, lines = 15): string {
	return run.stderr.split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
}

const MCP_TOOL_NAMES = new Set(["mcp", "mcpScript"]);
function isMcpTool(name: string): boolean {
	return MCP_TOOL_NAMES.has(name) || /^(binaryninja|bn_)/.test(name);
}

function endsWithTool(value: unknown, tool: string): boolean {
	return typeof value === "string" && (value === tool || value.endsWith(`_${tool}`));
}

async function main(): Promise<number> {
	const spec = resolvePiCommand();
	log(`resolved pi: ${describePiSpawnSpec(spec)}`);

	let serverName: string;
	try {
		serverName = await probeServer();
	} catch (err) {
		log(`SKIP: Binary Ninja MCP not reachable at ${BINJA_URL}: ${(err as Error).message}`);
		return 2;
	}
	log(`MCP server reachable: ${serverName} at ${BINJA_URL}`);

	const f = new Failures();
	const dirs: string[] = [];
	const mkProject = (): string => {
		const d = mkdtempSync(join(tmpdir(), "pi-mcp-smoke-"));
		dirs.push(d);
		return d;
	};

	try {
		// ---- Run A: gated off -------------------------------------------------
		const a = await runPi({ cwd: mkProject(), prompt: "Reply with exactly the word OK. Use no tools." });
		summarize("A(gated-off)", a);
		f.check(!a.timedOut, "A: timed out");
		f.check(a.exitCode === 0, `A: exit code ${a.exitCode}\n${stderrTail(a)}`);
		f.check(a.tools !== undefined, "A: probe line missing (mcp-probe extension did not report)");
		const leakedA = (a.tools ?? []).filter(isMcpTool);
		f.check(leakedA.length === 0, `A: MCP tools registered without project config: ${leakedA.join(", ")}`);
		f.check(a.starts.length === 0, `A: unexpected tool calls: ${a.starts.map((s) => s.toolName).join(", ")}`);
		f.check(a.commands !== undefined, "A: probe did not report commands");
		f.check((a.commands ?? []).includes("mcp"), `A: gated-off /mcp stub missing; commands=${(a.commands ?? []).join(",")}`);
		f.check(/\bOK\b/.test(a.finalText), `A: final text not OK: "${a.finalText}"`);

		// ---- Run B: gated on, real server ------------------------------------
		const projectB = mkProject();
		writeFileSync(
			join(projectB, ".mcp.json"),
			JSON.stringify({ mcpServers: { binaryninja: { url: BINJA_URL, lifecycle: "lazy" } } }, null, 2),
		);
		const b = await runPi({
			cwd: projectB,
			prompt:
				"You have a tool named `mcp` that proxies MCP servers. Do exactly these steps, in order, and do not stop early:\n" +
				"1. Call mcp with { \"search\": \"binary_view\" }.\n" +
				`2. Call mcp with { "tool": "${LIST_TOOL}", "args": {} } (use the exact tool name as returned by the search if it is prefixed).\n` +
				"3. Reply with the exact names of the tools found in step 1, one per line, then a blank line, then the raw result of step 2.\n" +
				"Do not use any other tool. Do not ask questions.",
		});
		summarize("B(binja)", b);
		f.check(!b.timedOut, "B: timed out");
		f.check(b.exitCode === 0, `B: exit code ${b.exitCode}\n${stderrTail(b)}`);
		f.check(b.tools !== undefined, "B: probe line missing");
		f.check((b.tools ?? []).includes("mcp"), `B: mcp proxy tool not registered; tools=${(b.tools ?? []).join(",")}`);
		const mcpStarts = b.starts.filter((s) => s.toolName === "mcp");
		const searchCall = mcpStarts.find((s) => typeof s.args?.search === "string");
		f.check(searchCall !== undefined, `B: no mcp({search}) call; calls=${JSON.stringify(b.starts.map((s) => [s.toolName, s.args]))}`);
		const listCall = mcpStarts.find((s) => endsWithTool(s.args?.tool, LIST_TOOL));
		f.check(listCall !== undefined, `B: no mcp({tool: ${LIST_TOOL}}) call; calls=${JSON.stringify(mcpStarts.map((s) => s.args))}`);
		if (listCall) {
			const end = b.ends.find((e) => e.toolCallId === listCall.toolCallId);
			f.check(end !== undefined, "B: no tool_execution_end for the list call");
			f.check(end?.isError === false, `B: list call errored: ${JSON.stringify(end?.result).slice(0, 300)}`);
			const resultText = JSON.stringify(end?.result ?? "");
			f.check(!/"error"\s*:/.test(resultText) || /"ok"\s*:\s*true/.test(resultText), `B: list result looks like an error: ${resultText.slice(0, 300)}`);
		}
		f.check(b.finalText.includes(LIST_TOOL), `B: final text does not mention ${LIST_TOOL}: "${b.finalText.slice(0, 200)}"`);

		// ---- Run C: env override -----------------------------------------------
		const c = await runPi({ cwd: mkProject(), env: { PI_MCP: "on" }, prompt: "Reply with exactly the word OK. Use no tools." });
		summarize("C(PI_MCP=on)", c);
		f.check(!c.timedOut, "C: timed out");
		f.check(c.exitCode === 0, `C: exit code ${c.exitCode}\n${stderrTail(c)}`);
		f.check((c.tools ?? []).includes("mcp"), `C: PI_MCP=on did not load the adapter; tools=${(c.tools ?? []).join(",")}`);
		f.check(/\bOK\b/.test(c.finalText), `C: final text not OK: "${c.finalText}"`);
	} finally {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	}

	if (f.list.length > 0) {
		log(`FAIL (${f.list.length}):`);
		for (const m of f.list) log(`  - ${m}`);
		return 1;
	}
	log("PASS: runs A, B, C");
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		log(`FAIL: ${(err as Error).stack ?? err}`);
		process.exit(1);
	},
);
