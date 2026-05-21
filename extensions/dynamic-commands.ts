import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Order matters: first match wins on name collision.
// Project beats global; within a scope, .pi/ beats .claude/.
const PROJECT_DIRS = [".pi/commands", ".claude/commands"];
const GLOBAL_DIRS = [".pi/commands", ".claude/commands"];

export interface CommandFile {
	name: string;
	path: string;
	body: string;
	description?: string;
	argumentHint?: string;
}

export interface ParsedFrontmatter {
	description?: string;
	argumentHint?: string;
	body: string;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { body: text };
	const block = m[1];
	const body = m[2];
	const raw: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		) {
			v = v.slice(1, -1);
		}
		raw[m[1]] = v;
	}
	return {
		description: raw["description"],
		argumentHint: raw["argument-hint"],
		body,
	};
}

export function firstNonEmptyLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (t) return t.length > 80 ? `${t.slice(0, 80)}…` : t;
	}
	return undefined;
}

export function discover(cwd: string, homeDir: string = homedir()): CommandFile[] {
	const candidates: string[] = [];
	for (const rel of PROJECT_DIRS) candidates.push(join(cwd, rel));
	for (const rel of GLOBAL_DIRS) candidates.push(join(homeDir, rel));

	const out = new Map<string, CommandFile>();
	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of entries) {
			if (!file.endsWith(".md")) continue;
			const full = join(dir, file);
			try {
				if (!statSync(full).isFile()) continue;
			} catch {
				continue;
			}
			const name = file.slice(0, -".md".length);
			if (out.has(name)) continue; // earlier (higher-priority) dir wins
			let text: string;
			try {
				text = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			const parsed = parseFrontmatter(text);
			out.set(name, {
				name,
				path: full,
				body: parsed.body,
				description: parsed.description ?? firstNonEmptyLine(parsed.body),
				argumentHint: parsed.argumentHint,
			});
		}
	}
	return Array.from(out.values());
}

// Tokenize args shell-style: bare words, "..." and '...' quoted groups.
export function tokenize(args: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: string | null = null;
	for (const ch of args) {
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

export function expand(body: string, args: string): string {
	const tokens = tokenize(args);
	return body
		.replace(/\$\{@:(\d+):(\d+)\}/g, (_m, n, l) =>
			tokens.slice(Number(n) - 1, Number(n) - 1 + Number(l)).join(" "),
		)
		.replace(/\$\{@:(\d+)\}/g, (_m, n) => tokens.slice(Number(n) - 1).join(" "))
		.replace(/\$ARGUMENTS\b/g, () => args)
		.replace(/\$@/g, () => tokens.join(" "))
		.replace(/\$(\d+)/g, (_m, n) => tokens[Number(n) - 1] ?? "");
}

export default function (pi: ExtensionAPI) {
	const commands = discover(process.cwd());

	for (const cmd of commands) {
		const baseDesc = cmd.description ?? `Run ${cmd.name}`;
		const description = cmd.argumentHint ? `${baseDesc} ${cmd.argumentHint}` : baseDesc;

		pi.registerCommand(cmd.name, {
			description,
			handler: async (args, ctx) => {
				const rendered = expand(cmd.body, args.trim());
				if (!ctx.isIdle()) {
					pi.sendUserMessage(rendered, { deliverAs: "followUp" });
					ctx.ui.notify(`/${cmd.name}: queued (agent busy)`, "info");
					return;
				}
				pi.sendUserMessage(rendered);
			},
		});
	}
}
