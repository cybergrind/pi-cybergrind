import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	appendEvent,
	finishRun,
	markRunning,
	startRun,
	type Run,
	type RunUsage,
} from "./run-registry.ts";

// Runner for spawning a nested `pi -p --mode json --no-session ...` child.
// Streams JSONL events from stdout, translates them into structured Run
// events, and routes everything through the central run-registry so the
// future panel (and any other consumer) sees a consistent view.

interface ContentPart {
	type: string;
	text?: string;
	name?: string;
}

interface AssistantMessage {
	role: "assistant" | "user" | "tool" | "system";
	content?: ContentPart[] | string;
	usage?: {
		input?: number;
		output?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

export interface RunResult {
	runId: string;
	exitCode: number;
	usage: RunUsage;
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	took: number;
	piCommand: string;
}

export interface RunOptions {
	task: string;
	parentDepth: number;
	parentRunId?: string;
	cwd?: string;
	model?: string;
	extraSystemPrompt?: string;
	signal?: AbortSignal;
	// Convenience callback for direct callers (tool execute / slash handler).
	// Identical information is also broadcast via run-registry events.
	onProgress?: (run: Run) => void;
}

export interface PiSpawnSpec {
	command: string;
	prefixArgs: string[];
	source: "PI_CMD" | "argv1" | "package-bin" | "path-fallback";
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
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

function extractThinking(content: ContentPart[] | string | undefined): string {
	if (!content || typeof content === "string") return "";
	return content
		.filter((c) => c.type === "thinking" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n")
		.trim();
}

export function trimOneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Shell-style tokenizer for PI_CMD. Handles bare words plus single/double
// quoted groups. Does NOT expand variables, globs, or escapes.
function tokenizeShellArgs(input: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: string | null = null;
	for (const ch of input) {
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			buf += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
		} else {
			buf += ch;
		}
	}
	if (buf) out.push(buf);
	return out;
}

function findPiPackageBin(startDir: string): string | undefined {
	let dir = startDir;
	for (let i = 0; i < 16; i++) {
		const nm = join(dir, "node_modules");
		for (const pkg of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
			const pkgJson = join(nm, pkg, "package.json");
			if (!existsSync(pkgJson)) continue;
			try {
				const manifest = JSON.parse(readFileSync(pkgJson, "utf8")) as {
					bin?: string | Record<string, string>;
				};
				const binField = manifest.bin;
				const binPath = typeof binField === "string"
					? binField
					: binField?.pi ?? Object.values(binField ?? {})[0];
				if (binPath) {
					const abs = resolvePath(dirname(pkgJson), binPath);
					if (existsSync(abs)) return abs;
				}
			} catch {
				/* skip malformed */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export interface ResolvePiOptions {
	env?: NodeJS.ProcessEnv;
	argv1?: string;
	cwd?: string;
	execPath?: string;
}

export function resolvePiCommand(opts: ResolvePiOptions = {}): PiSpawnSpec {
	const env = opts.env ?? process.env;
	const argv1 = opts.argv1 ?? process.argv[1];
	const cwd = opts.cwd ?? process.cwd();
	const execPath = opts.execPath ?? process.execPath;

	const override = env.PI_CMD?.trim();
	if (override) {
		const tokens = tokenizeShellArgs(override);
		if (tokens.length > 0) {
			return { command: tokens[0], prefixArgs: tokens.slice(1), source: "PI_CMD" };
		}
	}

	if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) {
		return { command: execPath, prefixArgs: [argv1], source: "argv1" };
	}

	const fromCwd = findPiPackageBin(cwd);
	if (fromCwd) {
		return { command: execPath, prefixArgs: [fromCwd], source: "package-bin" };
	}

	if (argv1) {
		const fromArgv1 = findPiPackageBin(dirname(argv1));
		if (fromArgv1) {
			return { command: execPath, prefixArgs: [fromArgv1], source: "package-bin" };
		}
	}

	return { command: "pi", prefixArgs: [], source: "path-fallback" };
}

export function describePiSpawnSpec(spec: PiSpawnSpec): string {
	return spec.prefixArgs.length > 0
		? `${spec.source}: ${spec.command} ${spec.prefixArgs.join(" ")}`
		: `${spec.source}: ${spec.command}`;
}

export async function runChildPi(opts: RunOptions): Promise<RunResult> {
	const spec = resolvePiCommand();
	const piCommand = describePiSpawnSpec(spec);

	const run = startRun({
		task: opts.task,
		parentDepth: opts.parentDepth,
		parentRunId: opts.parentRunId,
		piCommand,
	});

	const onChange = () => opts.onProgress?.(run);

	const piArgs = [...spec.prefixArgs, "-p", "--mode", "json", "--no-session"];

	let promptDir: string | undefined;
	if (opts.extraSystemPrompt && opts.extraSystemPrompt.trim()) {
		promptDir = mkdtempSync(join(tmpdir(), "pi-subagent-prompt-"));
		const promptPath = join(promptDir, "system.md");
		writeFileSync(promptPath, opts.extraSystemPrompt, { mode: 0o600 });
		piArgs.push("--append-system-prompt", promptPath);
	}

	if (opts.model) piArgs.push("--model", opts.model);
	piArgs.push(`Task: ${opts.task}`);

	let stderr = "";
	let pid: number | undefined;

	const onPiEvent = (evt: { type?: string; message?: AssistantMessage; tool?: string; name?: string }) => {
		if (!evt || typeof evt !== "object") return;
		const at = Date.now();

		if (evt.type === "message_end" && evt.message) {
			const msg = evt.message;
			if (msg.role === "assistant") {
				const turns = run.usage.turns + 1;
				const usage: RunUsage = {
					turns,
					input: run.usage.input + (msg.usage?.input ?? 0),
					output: run.usage.output + (msg.usage?.output ?? 0),
					cost: run.usage.cost + (msg.usage?.cost?.total ?? 0),
				};
				appendEvent(run.id, { type: "usage", at, usage });

				const thinking = extractThinking(msg.content);
				if (thinking) appendEvent(run.id, { type: "thinking", at, text: thinking });

				const text = extractText(msg.content);
				if (text) appendEvent(run.id, { type: "assistant_text", at, text });

				if (msg.stopReason) run.stopReason = msg.stopReason;
				if (msg.errorMessage) run.errorMessage = msg.errorMessage;

				onChange();
			}
			return;
		}

		if (evt.type === "tool_call_start") {
			appendEvent(run.id, { type: "tool_call", at, tool: evt.tool ?? evt.name ?? "tool" });
			onChange();
		}
	};

	onChange();

	const exitCode = await new Promise<number>((resolve) => {
		let proc: ChildProcess;
		try {
			proc = spawn(spec.command, piArgs, {
				cwd: opts.cwd ?? process.cwd(),
				env: {
					...process.env,
					PI_SUBAGENT_DEPTH: String(opts.parentDepth + 1),
					PI_SUBAGENT_RUN_ID: run.id,
					PI_SUBAGENT_PARENT_RUN_ID: opts.parentRunId ?? "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const line = `spawn failed (${piCommand}): ${(err as Error).message}`;
			stderr += `${line}\n`;
			appendEvent(run.id, { type: "stderr", at: Date.now(), line });
			resolve(1);
			return;
		}

		pid = proc.pid;
		markRunning(run.id, pid);

		let buffer = "";
		const consumeLine = (line: string) => {
			if (!line.trim()) return;
			try {
				onPiEvent(JSON.parse(line));
			} catch {
				/* non-JSON noise — ignore */
			}
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr += text;
			for (const line of text.split("\n")) {
				if (line.trim()) appendEvent(run.id, { type: "stderr", at: Date.now(), line });
			}
		});
		proc.on("close", (code) => {
			if (buffer.trim()) consumeLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", (err) => {
			const hint = spec.source === "path-fallback"
				? ` (could not locate pi — set PI_CMD env var to your pi binary or wrapper script)`
				: "";
			const line = `proc error (${piCommand})${hint}: ${err.message}`;
			stderr += `${line}\n`;
			appendEvent(run.id, { type: "stderr", at: Date.now(), line });
			resolve(1);
		});

		const abortControllers: AbortSignal[] = [run.abort.signal];
		if (opts.signal) abortControllers.push(opts.signal);

		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (!proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, 5000);
		};
		for (const sig of abortControllers) {
			if (sig.aborted) onAbort();
			else sig.addEventListener("abort", onAbort, { once: true });
		}
	});

	if (promptDir) {
		try {
			rmSync(promptDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	finishRun(run.id, {
		exitCode,
		stopReason: run.stopReason,
		errorMessage: run.errorMessage,
		pid,
	});

	onChange();

	return {
		runId: run.id,
		exitCode,
		usage: { ...run.usage },
		finalText: run.lastAssistantText,
		stopReason: run.stopReason,
		errorMessage: run.errorMessage,
		stderr,
		took: ((run.endedAt ?? Date.now()) - run.startedAt) / 1000,
		piCommand,
	};
}

export function formatStats(usage: RunUsage, tookSec: number): string {
	return `${usage.turns} turns ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)} • ${tookSec.toFixed(1)}s`;
}

export function isErrored(result: RunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function formatHeader(result: RunResult): string {
	const stats = formatStats(result.usage, result.took);
	if (isErrored(result)) {
		const stop = result.stopReason ? ` stop=${result.stopReason}` : "";
		return `[subagent ✗ exit=${result.exitCode}${stop} • ${stats}]`;
	}
	return `[subagent ✓ • ${stats}]`;
}

export function resolveOutput(result: RunResult): string {
	return result.finalText || result.errorMessage || result.stderr.trim() || "(no output)";
}

// Render the trailing N events of a run as one-line decorations. Used by
// the slash command's widget and the smoke test's progress printer; the
// future panel can build richer renderings from run.events directly.
export function formatRecentEvents(run: Run, lines = 8): string[] {
	const out: string[] = [];
	for (const ev of run.events.slice(-lines * 3)) {
		if (ev.type === "tool_call") out.push(`🔧 ${ev.tool}`);
		else if (ev.type === "assistant_text") out.push(`💬 ${trimOneLine(ev.text, 100)}`);
		else if (ev.type === "stderr") out.push(`⚠ ${trimOneLine(ev.line, 100)}`);
	}
	return out.slice(-lines);
}
