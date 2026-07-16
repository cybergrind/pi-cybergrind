import { spawn, type ChildProcess } from "node:child_process";
import { resolvePiCommand } from "./pi-runner.ts";
import type { AgentClient, AgentClientEvent, SpawnAgentOptions } from "./agent-pool.ts";

// Concrete AgentClient backing an interactive subagent with a real, long-lived
// `pi --mode rpc` child. We hand-roll the JSONL transport (rather than using
// the library's RpcClient) for the same reason pi-runner.ts spawns directly:
// it lets us resolve pi via resolvePiCommand() and honor PI_CMD, including pi
// installs that are not a bare `node dist/cli.js`.
//
// Protocol (see pi's dist/modes/rpc): commands are JSON lines on stdin;
// responses (`type:"response"`) and AgentEvents are JSON lines on stdout;
// `extension_ui_request` lines must be answered or the child blocks.

interface ContentPart {
	type: string;
	text?: string;
}
interface AssistantMessage {
	role?: string;
	content?: ContentPart[] | string;
	stopReason?: string;
	errorMessage?: string;
}

const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

function childDepth(): number {
	const cur = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
	return cur + 1;
}

export function serializeCommand(cmd: Record<string, unknown>): string {
	return `${JSON.stringify(cmd)}\n`;
}

/** CLI args for the rpc child: the resolved prefix, then `--mode rpc`, then optional model. */
export function buildRpcArgs(prefixArgs: string[], opts: { model?: string }): string[] {
	const args = [...prefixArgs, "--mode", "rpc"];
	if (opts.model) args.push("--model", opts.model);
	return args;
}

function extractText(content: ContentPart[] | string | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n")
		.trim();
}

/** Translate one parsed stdout line into zero or more semantic pool events. */
export function toAgentClientEvents(obj: unknown): AgentClientEvent[] {
	if (!obj || typeof obj !== "object") return [];
	const evt = obj as { type?: string; message?: AssistantMessage; tool?: string; toolName?: string };

	switch (evt.type) {
		case "agent_start":
			return [{ type: "agent_start" }];
		case "agent_end":
			return [{ type: "agent_end" }];
		case "tool_execution_start":
		case "tool_call_start":
			return [{ type: "tool_call", tool: evt.toolName ?? evt.tool ?? "tool" }];
		case "message_end": {
			const msg = evt.message;
			if (!msg || msg.role !== "assistant") return [];
			const out: AgentClientEvent[] = [];
			const text = extractText(msg.content);
			if (text) out.push({ type: "assistant_text", text });
			if (msg.stopReason === "error" || msg.errorMessage) {
				out.push({ type: "error", message: msg.errorMessage || "subagent turn errored" });
			}
			return out;
		}
		default:
			return [];
	}
}

export class RpcAgentClient implements AgentClient {
	private proc?: ChildProcess;
	private listeners = new Set<(ev: AgentClientEvent) => void>();
	private buffer = "";
	private requestId = 0;
	private stopping = false;
	private readonly opts: SpawnAgentOptions;

	constructor(opts: SpawnAgentOptions) {
		this.opts = opts;
	}

	start(): Promise<void> {
		const spec = resolvePiCommand();
		const args = buildRpcArgs(spec.prefixArgs, { model: this.opts.model });

		return new Promise<void>((resolve, reject) => {
			let proc: ChildProcess;
			try {
				proc = spawn(spec.command, args, {
					cwd: this.opts.cwd ?? process.cwd(),
					env: {
						...process.env,
						[DEPTH_ENV]: String(childDepth()),
						PI_INTERACTIVE_SUBAGENT: "1",
					},
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				reject(err);
				return;
			}
			this.proc = proc;

			proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
			proc.stderr?.on("data", () => {
				/* stderr is noisy diagnostics; surfaced only if the process dies */
			});
			proc.on("error", (err) => {
				this.dispatch({ type: "error", message: err.message });
				reject(err);
			});
			proc.on("close", (code) => {
				this.dispatch({ type: "exit", code: code ?? 0 });
			});
			// stdin buffers until the child's reader is ready, so it is safe to
			// resolve as soon as the process is spawned.
			proc.once("spawn", () => resolve());
		});
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.consumeLine(line);
	}

	private consumeLine(line: string): void {
		if (!line.trim()) return;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			return; // non-JSON noise
		}
		// A headless child blocks on any extension UI request; auto-decline so a
		// subagent that calls select/confirm/input doesn't deadlock.
		if ((obj as { type?: string }).type === "extension_ui_request") {
			const id = (obj as { id?: string }).id;
			if (id) this.write({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		for (const ev of toAgentClientEvents(obj)) this.dispatch(ev);
	}

	private dispatch(ev: AgentClientEvent): void {
		for (const l of this.listeners) l(ev);
	}

	private write(cmd: Record<string, unknown>): void {
		this.proc?.stdin?.write(serializeCommand({ ...cmd, id: `req_${++this.requestId}` }));
	}

	async prompt(text: string): Promise<void> {
		this.write({ type: "prompt", message: text });
	}

	async followUp(text: string): Promise<void> {
		this.write({ type: "follow_up", message: text });
	}

	async abort(): Promise<void> {
		this.write({ type: "abort" });
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			proc.once("close", done);
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (proc.exitCode === null) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, 3000);
		});
	}

	onEvent(cb: (ev: AgentClientEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
}

/** Default factory used by the extension; tests inject their own. */
export function createRpcAgentClient(opts: SpawnAgentOptions): AgentClient {
	return new RpcAgentClient(opts);
}
