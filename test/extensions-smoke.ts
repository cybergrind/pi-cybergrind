// Smoke test for the whole package against a real pi process.
//
// Run with:
//   PI_CMD=/path/to/pi-test.sh npm run test:extensions
//
// Loads this repository the way pi loads a package (`-e <repo root>`, which
// goes through the `pi.extensions` manifest in package.json) into a
// `pi --mode rpc` child and checks what a pi update is most likely to break:
//
//   1. load       every extension loads without an error, and registers its
//                 commands and tools (no model call)
//   2. dispatch   slash commands reach their handlers and can notify (no model)
//   3. template   a dynamic command expands its arguments and its text becomes
//                 the next user turn (pi.sendUserMessage)
//   4. tool       the model can call the `subagent` tool, which spawns a nested
//                 pi and returns its output as the tool result
//   5. installed  plain `pi` with the user's own settings (the path real
//                 sessions take) loads the package without warnings, and no
//                 built-in extension competes for its commands. Skipped with a
//                 note when the package is not registered in pi's settings.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describePiSpawnSpec, resolvePiCommand } from "../extensions/lib/pi-runner.ts";
import { parseProbe } from "./fixtures/probe.ts";
import { assistantText, RpcDriver, type RpcLine } from "./fixtures/rpc-driver.ts";

const TURN_TIMEOUT_MS = 120_000;
const ROOT = resolve(process.env.PI_CYBERGRIND_ROOT ?? process.cwd());
const PROBE_EXT = join(ROOT, "test/fixtures/probe.ts");
const TEMPLATE = "zz-smoke-echo";

const EXPECTED_COMMANDS: Record<string, string> = {
	mcp: "extensions/mcp.ts",
	subagent: "extensions/subagent.ts",
	"subagent-abort": "extensions/subagent.ts",
	"subagent-switch": "extensions/subagent-switch.ts",
	"subagent-interactive": "extensions/subagent-switch.ts",
	[TEMPLATE]: "extensions/dynamic-commands.ts",
};

function log(line: string): void {
	process.stderr.write(`[ext-smoke] ${line}\n`);
}

class Failures {
	list: string[] = [];
	check(cond: boolean, msg: string): void {
		log(`  ${cond ? "✓" : "✗"} ${msg.split("\n")[0]}`);
		if (!cond) this.list.push(msg);
	}
}

interface CommandInfo {
	name: string;
	sourceInfo?: { path?: string };
}

async function runTurn(pi: RpcDriver, message: string): Promise<RpcLine[]> {
	const from = pi.lines.length;
	const res = await pi.send({ type: "prompt", message });
	if (res.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(res)}`);
	await pi.waitFor((l) => l.type === "agent_end", TURN_TIMEOUT_MS, `agent_end for "${message.slice(0, 40)}"`, from);
	return pi.lines.slice(from);
}

async function main(): Promise<number> {
	log(`resolved pi: ${describePiSpawnSpec(resolvePiCommand())}`);
	const f = new Failures();

	const project = mkdtempSync(join(tmpdir(), "pi-ext-smoke-"));
	// .claude/commands, not .pi/commands: pi migrates the latter to .pi/prompts.
	mkdirSync(join(project, ".claude/commands"), { recursive: true });
	writeFileSync(
		join(project, ".claude/commands", `${TEMPLATE}.md`),
		"---\ndescription: smoke template\nargument-hint: <word>\n---\nReply with exactly the word $1 and nothing else. Use no tools.\n",
	);

	// PI_MCP must not leak in from the caller's shell: the gate decides from the project dir.
	const pi = new RpcDriver({
		cwd: project,
		args: ["--no-extensions", "-e", ROOT, "-e", PROBE_EXT],
		env: { PI_MCP: undefined },
	});

	try {
		// ---- 1. load ----------------------------------------------------------
		log("1. load");
		const res = await pi.send({ type: "get_commands" });
		const commands = ((res.data as { commands?: CommandInfo[] } | undefined)?.commands ?? []) as CommandInfo[];
		for (const [name, file] of Object.entries(EXPECTED_COMMANDS)) {
			const cmd = commands.find((c) => c.name === name);
			f.check(cmd !== undefined, `/${name} is registered; commands=${commands.map((c) => c.name).join(",")}`);
			if (cmd) {
				f.check(
					cmd.sourceInfo?.path === join(ROOT, file),
					`/${name} comes from ${file}\n  got ${cmd.sourceInfo?.path}`,
				);
			}
		}
		await pi.waitForStderr(/\[pi-probe\] /, 15_000).catch(() => {});
		const probe = parseProbe(pi.stderr);
		f.check(probe !== undefined, `probe extension reported\n${pi.stderrTail()}`);
		f.check((probe?.tools ?? []).includes("subagent"), `subagent tool is registered; tools=${(probe?.tools ?? []).join(",")}`);
		f.check(!/Failed to load extension/i.test(pi.stderr), `no extension failed to load\n${pi.stderrTail()}`);

		// ---- 2. dispatch ------------------------------------------------------
		log("2. dispatch");
		for (const [command, expected] of [
			["/mcp status", /^MCP is off for this session: no \.mcp\.json or \.pi\/mcp\.json/],
			["/subagent", /^\/subagent: provide a task description$/],
			["/subagent-interactive", /^\/subagent-interactive: provide a task description$/],
			["/subagent-switch", /^no interactive subagents/],
			["/subagent-abort", /^\/subagent-abort: pass a run-id prefix/],
		] as Array<[string, RegExp]>) {
			const before = pi.notifications().length;
			await pi.send({ type: "prompt", message: command });
			const got = await pi
				.waitFor((l) => l.type === "extension_ui_request" && l.method === "notify" && expected.test(String(l.message)), 10_000, command)
				.then(() => true, () => false);
			f.check(got, `${command} notifies ${expected}\n  got ${JSON.stringify(pi.notifications().slice(before))}`);
		}

		// ---- 3. template ------------------------------------------------------
		log("3. template");
		const templateTurn = await runTurn(pi, `/${TEMPLATE} PONG`);
		const templateText = templateTurn.map(assistantText).filter(Boolean).join("\n");
		f.check(/\bPONG\b/.test(templateText), `/${TEMPLATE} PONG makes the model answer PONG\n  got "${templateText.slice(0, 200)}"`);

		// ---- 4. tool ----------------------------------------------------------
		log("4. tool");
		const toolPrompt =
			"Call the `subagent` tool exactly once with only this parameter: " +
			'{ "task": "Reply with exactly the word NESTED and nothing else. Use no tools." }. ' +
			"Then reply with exactly the text the tool returned. Do not use any other tool.";
		const calledSubagent = (turn: RpcLine[]) => turn.some((l) => l.type === "tool_execution_start" && l.toolName === "subagent");
		let toolTurn = await runTurn(pi, toolPrompt);
		if (!calledSubagent(toolTurn)) {
			// Models occasionally answer without calling the tool; one retry keeps that from failing the run.
			log("  (model answered without the tool; asking once more)");
			toolTurn = await runTurn(pi, `You did not call the tool. ${toolPrompt}`);
		}
		const start = toolTurn.find((l) => l.type === "tool_execution_start" && l.toolName === "subagent");
		f.check(
			start !== undefined,
			`model called the subagent tool\n  tools called=[${toolTurn.filter((l) => l.type === "tool_execution_start").map((l) => l.toolName).join(",")}] ` +
				`text="${toolTurn.map(assistantText).filter(Boolean).join(" | ").slice(0, 300)}"`,
		);
		const end = toolTurn.find((l) => l.type === "tool_execution_end" && l.toolCallId === start?.toolCallId);
		f.check(end !== undefined, "subagent tool call finished");
		const resultText = JSON.stringify(end?.result ?? "");
		f.check(end?.isError === false, `subagent tool call did not error\n  result ${resultText.slice(0, 400)}`);
		f.check(resultText.includes("[subagent ✓"), `tool result has the success header\n  result ${resultText.slice(0, 400)}`);
		f.check(/NESTED/.test(resultText), `tool result carries the nested pi's answer\n  result ${resultText.slice(0, 400)}`);

		const errors = pi.lines.filter((l) => l.type === "extension_error");
		f.check(errors.length === 0, `no extension_error events\n  ${JSON.stringify(errors).slice(0, 600)}`);
	} catch (err) {
		f.check(false, `exception: ${(err as Error).message}`);
	} finally {
		await pi.stop();
		rmSync(project, { recursive: true, force: true });
	}

	// ---- 5. installed -----------------------------------------------------------
	log("5. installed");
	const project2 = mkdtempSync(join(tmpdir(), "pi-ext-smoke-"));
	const installed = new RpcDriver({ cwd: project2, args: ["-e", PROBE_EXT], env: { PI_MCP: undefined } });
	try {
		const res = await installed.send({ type: "get_commands" });
		const commands = ((res.data as { commands?: CommandInfo[] } | undefined)?.commands ?? []) as CommandInfo[];
		await installed.waitForStderr(/\[pi-probe\] /, 15_000).catch(() => {});
		const ours = commands.filter((c) => c.sourceInfo?.path?.startsWith(`${ROOT}/`));
		if (ours.length === 0) {
			log(`  (skipped: ${ROOT} is not registered as a package in pi's settings)`);
		} else {
			for (const [name, file] of Object.entries(EXPECTED_COMMANDS)) {
				if (name === TEMPLATE) continue;
				const cmd = commands.find((c) => c.name === name);
				f.check(cmd?.sourceInfo?.path === join(ROOT, file), `installed: /${name} comes from ${file}\n  got ${cmd?.sourceInfo?.path}`);
			}
			const warnings = installed.stderr.split("\n").filter((l) => /^(Warning|Error)\b/i.test(l) || /Failed to load extension/i.test(l));
			f.check(
				warnings.length === 0,
				`installed: pi starts without extension warnings\n  ${warnings.join("\n  ").slice(0, 900)}\n` +
					'  (a built-in extension that registers the same command is disabled with e.g. "extensions": ["-builtin:mcp"] in ~/.pi/agent/settings.json)',
			);
		}
	} catch (err) {
		f.check(false, `installed: exception: ${(err as Error).message}`);
	} finally {
		await installed.stop();
		rmSync(project2, { recursive: true, force: true });
	}

	if (f.list.length > 0) {
		log(`FAIL (${f.list.length}):`);
		for (const m of f.list) log(`  - ${m}`);
		return 1;
	}
	log("PASS");
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		log(`FAIL: ${(err as Error).stack ?? err}`);
		process.exit(1);
	},
);
