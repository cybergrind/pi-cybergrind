import { spawn, type ChildProcess } from "node:child_process";
import { resolvePiCommand } from "../../extensions/lib/pi-runner.ts";

// Minimal driver for a real `pi --mode rpc` child, shared by the smoke tests.
// Records every stdout JSON line and all of stderr so assertions can look at
// what pi actually emitted.

export interface RpcLine {
	type?: string;
	[key: string]: unknown;
}

export interface RpcDriverOptions {
	cwd: string;
	/** Extra CLI args after `--mode rpc --no-session`. */
	args?: string[];
	env?: Record<string, string | undefined>;
}

export class RpcDriver {
	readonly lines: RpcLine[] = [];
	stderr = "";
	exitCode: number | null = null;
	private proc: ChildProcess;
	private buffer = "";
	private nextId = 0;
	private waiters = new Set<() => void>();

	constructor(opts: RpcDriverOptions) {
		const spec = resolvePiCommand();
		const args = [...spec.prefixArgs, "--mode", "rpc", "--no-session", ...(opts.args ?? [])];
		if (process.env.PI_MODEL) args.push("--model", process.env.PI_MODEL);
		this.proc = spawn(spec.command, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			const parts = this.buffer.split("\n");
			this.buffer = parts.pop() ?? "";
			for (const line of parts) this.consume(line);
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
			this.wake();
		});
		this.proc.on("close", (code) => {
			this.exitCode = code ?? -1;
			this.wake();
		});
		this.proc.on("error", (err) => {
			this.stderr += `spawn error: ${err.message}\n`;
			this.exitCode = -1;
			this.wake();
		});
	}

	private consume(line: string): void {
		if (!line.trim()) return;
		let obj: RpcLine;
		try {
			obj = JSON.parse(line) as RpcLine;
		} catch {
			return;
		}
		this.lines.push(obj);
		// A headless child blocks on dialog requests; decline them like the pool does.
		if (obj.type === "extension_ui_request" && obj.method !== "notify" && typeof obj.id === "string") {
			this.write({ type: "extension_ui_response", id: obj.id, cancelled: true });
		}
		this.wake();
	}

	private wake(): void {
		for (const w of [...this.waiters]) w();
	}

	private write(cmd: Record<string, unknown>): void {
		this.proc.stdin?.write(`${JSON.stringify(cmd)}\n`);
	}

	/** Send a command; resolves with its `response` line. */
	async send(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcLine> {
		const id = `t_${++this.nextId}`;
		this.write({ ...cmd, id });
		return this.waitFor((l) => l.type === "response" && l.id === id, timeoutMs, `response to ${String(cmd.type)}`);
	}

	/** Resolve with the first recorded line (from index `from`) matching `pred`. */
	waitFor(pred: (line: RpcLine) => boolean, timeoutMs: number, what: string, from = 0): Promise<RpcLine> {
		return new Promise<RpcLine>((resolve, reject) => {
			let cursor = from;
			const check = () => {
				for (; cursor < this.lines.length; cursor++) {
					if (pred(this.lines[cursor])) {
						done();
						resolve(this.lines[cursor]);
						return;
					}
				}
				if (this.exitCode !== null) {
					done();
					reject(new Error(`pi exited (${this.exitCode}) while waiting for ${what}\n${this.stderrTail()}`));
				}
			};
			const timer = setTimeout(() => {
				done();
				reject(new Error(`timeout (${timeoutMs}ms) waiting for ${what}\n${this.stderrTail()}`));
			}, timeoutMs);
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(check);
			};
			this.waiters.add(check);
			check();
		});
	}

	/** Wait until stderr matches. */
	waitForStderr(re: RegExp, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const check = () => {
				if (re.test(this.stderr)) {
					done();
					resolve();
				} else if (this.exitCode !== null) {
					done();
					reject(new Error(`pi exited (${this.exitCode}) before stderr matched ${re}\n${this.stderrTail()}`));
				}
			};
			const timer = setTimeout(() => {
				done();
				reject(new Error(`timeout (${timeoutMs}ms) waiting for stderr ${re}\n${this.stderrTail()}`));
			}, timeoutMs);
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(check);
			};
			this.waiters.add(check);
			check();
		});
	}

	notifications(): string[] {
		return this.lines
			.filter((l) => l.type === "extension_ui_request" && l.method === "notify")
			.map((l) => String(l.message ?? ""));
	}

	stderrTail(lines = 15): string {
		return this.stderr.split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
	}

	async stop(): Promise<void> {
		if (this.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			this.proc.once("close", () => resolve());
			this.proc.stdin?.end();
			this.proc.kill("SIGTERM");
			setTimeout(() => {
				if (this.exitCode === null) this.proc.kill("SIGKILL");
			}, 3000).unref();
		});
	}
}

/** Text of an assistant `message_end` line, or "" for anything else. */
export function assistantText(line: RpcLine): string {
	if (line.type !== "message_end") return "";
	const msg = line.message as { role?: string; content?: unknown } | undefined;
	if (msg?.role !== "assistant") return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}
