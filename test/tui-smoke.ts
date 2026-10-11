// Smoke test for the interactive (TUI) side of the package against a real pi.
//
// Run with:
//   PI_CMD=/path/to/pi-test.sh npm run test:tui
//
// Starts pi inside a private tmux server (own socket, never the user's), types
// into it with `send-keys`, and reads the screen with `capture-pane`. Covers
// what no headless mode can reach:
//
//   prompt-history  Up on an empty editor brings back prompts from an earlier
//                   session, and submitted prompts are written to the history file
//   switcher        /subagent-interactive, the Alt+S overlay (ctx.ui.custom),
//                   the `input` hook that redirects typed text to the focused
//                   subagent, the focus widget, and Esc (ui.onTerminalInput)
//   mcp             the gated-off `/mcp` stub, `/mcp load`, and the adapter's
//                   own `/mcp` panel taking over afterwards
//   scroll-compose  Ctrl+U puts the pi pane into tmux copy-mode, opens nvim in
//                   a popup, and the text written there lands in pi's editor.
//                   Needs pi to keep the terminal's scrollback (not the
//                   alternate screen), which this also asserts.
//
// Needs tmux, nvim and script(1). pi runs with the user's real settings, so
// the result reflects what `pi` does on this machine.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describePiSpawnSpec, resolvePiCommand } from "../extensions/lib/pi-runner.ts";

const ROOT = resolve(process.env.PI_CYBERGRIND_ROOT ?? process.cwd());
const SESSION = "pi";
const COLS = 140;
const ROWS = 45;
const TURN_TIMEOUT_MS = 120_000;

function log(line: string): void {
	process.stderr.write(`[tui-smoke] ${line}\n`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

class Failures {
	list: string[] = [];
	check(cond: boolean, msg: string): void {
		log(`  ${cond ? "✓" : "✗"} ${msg.split("\n")[0]}`);
		if (!cond) this.list.push(msg);
	}
}

class Tmux {
	readonly socket: string;
	private readonly env: NodeJS.ProcessEnv;
	private client?: ChildProcess;

	constructor(socket: string) {
		this.socket = socket;
		// Never talk to (or inherit from) a tmux the test itself runs inside.
		this.env = { ...process.env };
		delete this.env.TMUX;
		delete this.env.TMUX_PANE;
	}

	run(...args: string[]): string {
		return execFileSync("tmux", ["-S", this.socket, ...args], { env: this.env, encoding: "utf8" });
	}

	start(command: string, cwd: string): void {
		this.run("new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS), "-c", cwd, command);
	}

	keys(...keys: string[]): void {
		this.run("send-keys", "-t", SESSION, ...keys);
	}

	/** Type literal text, then press Enter. */
	submit(text: string): void {
		this.run("send-keys", "-t", SESSION, "-l", text);
		this.keys("Enter");
	}

	/**
	 * Like submit(), for commands with argument completions: when the
	 * completion menu is open the first Enter only accepts the completion and
	 * the text stays in the editor, so press Enter once more in that case.
	 */
	async submitWithCompletion(text: string): Promise<void> {
		this.submit(text);
		await sleep(700);
		if (this.screen().split("\n").some((l) => l.trim() === text)) this.keys("Enter");
	}

	screen(): string {
		return this.run("capture-pane", "-p", "-t", SESSION);
	}

	format(fmt: string): string {
		return this.run("display-message", "-p", "-t", SESSION, fmt).trim();
	}

	alive(): boolean {
		return spawnSync("tmux", ["-S", this.socket, "has-session", "-t", SESSION], { env: this.env }).status === 0;
	}

	/**
	 * Attach a client on a pty so `display-popup` has somewhere to draw. Keys
	 * written to the returned process's stdin go to the client, i.e. to the popup.
	 */
	attachClient(): ChildProcess {
		const attach = `stty rows ${ROWS} cols ${COLS}; exec tmux -S ${shellQuote(this.socket)} attach -t ${SESSION}`;
		this.client = spawn("script", ["-qfc", attach, "/dev/null"], {
			env: { ...this.env, TERM: "xterm-256color" },
			stdio: ["pipe", "ignore", "ignore"],
		});
		return this.client;
	}

	kill(): void {
		spawnSync("tmux", ["-S", this.socket, "kill-server"], { env: this.env });
		this.client?.kill("SIGKILL");
	}
}

async function waitUntil(what: string, timeoutMs: number, cond: () => boolean): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await sleep(200);
	}
	log(`  (timeout after ${timeoutMs}ms waiting for ${what})`);
	return false;
}

function screenTail(tmux: Tmux, lines = 14): string {
	return tmux.screen().split("\n").filter((l) => l.trim()).slice(-lines).map((l) => `    | ${l}`).join("\n");
}

function hasCommand(name: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

async function main(): Promise<number> {
	const spec = resolvePiCommand();
	log(`resolved pi: ${describePiSpawnSpec(spec)}`);
	for (const tool of ["tmux", "nvim", "script"]) {
		if (!hasCommand(tool)) {
			log(`FAIL: ${tool} is required for this test and was not found on PATH`);
			return 1;
		}
	}

	const f = new Failures();
	const work = mkdtempSync(join(tmpdir(), "pi-tui-smoke-"));
	const tmux = new Tmux(join(work, "tmux.sock"));
	const sees = (re: RegExp) => re.test(tmux.screen());
	const expectScreen = async (re: RegExp, msg: string, timeoutMs = 15_000) => {
		const ok = await waitUntil(String(re), timeoutMs, () => sees(re));
		f.check(ok, `${msg}\n${screenTail(tmux)}`);
		return ok;
	};

	try {
		const piCommand = [spec.command, ...spec.prefixArgs, "--no-session", "--no-extensions", "-e", ROOT]
			.map(shellQuote)
			.join(" ");
		// A private history file, seeded as if an earlier session in this project had run.
		const historyFile = join(work, "prompt-history.jsonl");
		writeFileSync(
			historyFile,
			["zz-history-older", "zz-history-newest"].map((text, at) => `${JSON.stringify({ cwd: work, text, at })}\n`).join(""),
		);
		// PI_MCP is cleared so the MCP gate decides from the (empty) project dir.
		tmux.start(`env -u PI_MCP PI_PROMPT_HISTORY_FILE=${shellQuote(historyFile)} ${piCommand}`, work);

		// ---- startup ----------------------------------------------------------
		log("startup");
		// The editor is framed by horizontal rules; once they are drawn pi takes input.
		const started = await waitUntil("pi to draw its editor", 60_000, () => tmux.alive() && sees(/─{20,}/));
		f.check(started, `pi starts and draws its editor\n${tmux.alive() ? screenTail(tmux) : "    (tmux session exited)"}`);
		if (!started) throw new Error("pi did not start");
		await sleep(1000);
		f.check(!sees(/Failed to load extension/i), `no extension failed to load\n${screenTail(tmux, 30)}`);

		// ---- prompt-history ---------------------------------------------------
		log("prompt-history");
		tmux.keys("Up");
		await expectScreen(/zz-history-newest/, "Up on an empty editor shows the last prompt of an earlier session");
		tmux.keys("Up");
		await expectScreen(/zz-history-older/, "Up again shows the prompt before it");
		tmux.keys("Down");
		tmux.keys("Down");
		const cleared = await waitUntil("editor to clear", 5_000, () => !sees(/zz-history-/));
		f.check(cleared, `Down past the newest prompt returns to the empty draft\n${screenTail(tmux)}`);

		// ---- switcher ---------------------------------------------------------
		log("switcher");
		tmux.submit("/subagent-switch");
		await expectScreen(/no interactive subagents/, "/subagent-switch with an empty pool says so");

		tmux.submit("/subagent-interactive Reply with the single word READY and nothing else. Use no tools.");
		await expectScreen(/started — Alt\+S to switch/, "/subagent-interactive spawns a subagent", 30_000);

		tmux.keys("M-s");
		const overlay = await expectScreen(/⌂ top-level \(you\)/, "Alt+S opens the switcher overlay");
		if (overlay) {
			// The overlay redraws on pool events, so the agent's row turns idle live.
			await expectScreen(/Reply with the single word READY.*· idle/, "overlay lists the subagent and shows it idle after its first turn", TURN_TIMEOUT_MS);
			tmux.keys("Down");
			await sleep(300);
			tmux.keys("Enter");
			await expectScreen(/focus: .* — type to send/, "choosing the subagent focuses it");
			await expectScreen(/▶ subagent: .*Alt\+S to switch/, "focus widget is shown above the editor");

			tmux.submit("Now reply with the single word DONE and nothing else.");
			await expectScreen(/→ .* \((prompt|followUp)\)/, "typed text is redirected to the focused subagent");
			f.check(!sees(/Now reply with the single word DONE/), `redirected text is not sent to the top-level agent\n${screenTail(tmux)}`);

			// Esc interrupts a busy agent and leaves an idle one; wait for idle so it leaves.
			await waitUntil("focused subagent to go idle", TURN_TIMEOUT_MS, () => sees(/▶ subagent: .*\(idle\)/));
			tmux.keys("Escape");
			await expectScreen(/left subagent — back to top-level/, "Esc on an idle focused subagent returns to top-level");
			f.check(!sees(/▶ subagent:/), `focus widget is removed after leaving\n${screenTail(tmux)}`);
		}

		// ---- mcp --------------------------------------------------------------
		log("mcp");
		tmux.submit("/mcp");
		await expectScreen(/MCP is off for this session/, "/mcp shows the gated-off notice in a project without MCP config");
		await tmux.submitWithCompletion("/mcp load");
		await expectScreen(/pi-mcp-adapter loaded for this session/, "/mcp load loads the adapter on demand", 30_000);
		tmux.submit("/mcp");
		const panel = await expectScreen(/Esc goes back|Run setup/, "/mcp now opens the adapter's panel", 30_000);
		if (panel) {
			tmux.keys("Escape");
			const closed = await waitUntil("adapter panel to close", 10_000, () => !sees(/Esc goes back/));
			f.check(closed, `Esc closes the adapter's panel\n${screenTail(tmux)}`);
		}

		// ---- scroll-compose ---------------------------------------------------
		log("scroll-compose");
		f.check(
			tmux.format("#{alternate_on}") === "0",
			"pi keeps the terminal scrollback (not the alternate screen), so tmux copy-mode can scroll its transcript\n" +
				'    pi is in fullscreen mode; set "tuiMode": "regular" in ~/.pi/agent/settings.json',
		);
		const client = tmux.attachClient();
		const attached = await waitUntil("tmux client to attach", 10_000, () => tmux.run("list-clients").trim() !== "");
		f.check(attached, "a tmux client is attached for the popup");

		tmux.run("send-keys", "-t", SESSION, "-l", "draft");
		await sleep(500);
		tmux.keys("C-u");
		const copyMode = await waitUntil("pi pane to enter copy-mode", 10_000, () => tmux.format("#{pane_in_mode}") === "1");
		f.check(copyMode, `Ctrl+U puts the pi pane into tmux copy-mode\n${screenTail(tmux)}`);
		const nvimUp = await waitUntil("nvim popup", 10_000, () =>
			spawnSync("pgrep", ["-f", "nvim.*pi-scroll-compose-.*input\\.txt"], { stdio: "ignore" }).status === 0,
		);
		f.check(nvimUp, `Ctrl+U opens nvim in a tmux popup\n${screenTail(tmux)}`);
		if (nvimUp) {
			await sleep(1500); // let nvim finish loading the user's config and our init.lua
			client.stdin?.write("A more\x1b");
			await sleep(700);
			client.stdin?.write("\x1b"); // normal-mode Esc: save + quit
			const left = await waitUntil("copy-mode to end", 10_000, () => tmux.format("#{pane_in_mode}") === "0");
			f.check(left, "leaving nvim cancels copy-mode");
			await expectScreen(/draft more/, "text edited in nvim lands in pi's editor");
		}
		f.check(!sees(/scroll-compose:/), `scroll-compose reported no error\n${screenTail(tmux)}`);

		// ---- prompt-history, written side -------------------------------------
		const saved = readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cwd: string; text: string });
		f.check(
			saved.some((e) => e.cwd === work && e.text === "/subagent-switch"),
			`submitted prompts are appended to the history file\n    ${JSON.stringify(saved.map((e) => e.text))}`,
		);
	} catch (err) {
		f.check(false, `exception: ${(err as Error).message}`);
	} finally {
		tmux.kill();
		rmSync(work, { recursive: true, force: true });
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
