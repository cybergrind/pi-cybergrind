import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Store for prompt history that outlives a pi session.
// Pure logic: no pi imports (unit tests run under node --experimental-strip-types).
//
// One JSONL file holds every project's prompts, one `{cwd, text, at}` object
// per line, oldest first. Appends are a single small write, so several pi
// processes can share the file.

/** Overrides the history file location (used by the smoke test). */
export const ENV_FILE = "PI_PROMPT_HISTORY_FILE";

/** Prompts restored per project; pi's editor keeps at most this many. */
export const HISTORY_LIMIT = 100;

/** The file is rewritten without stale lines once it grows past this. */
export const COMPACT_ABOVE_LINES = 5000;

export interface HistoryEntry {
	cwd: string;
	text: string;
	at: number;
}

/** One project reached through a symlink and directly must share a history. */
function projectKey(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

function writeEntries(file: string, entries: HistoryEntry[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
	renameSync(tmp, file);
}

function parseLine(line: string): HistoryEntry | undefined {
	if (!line.trim()) return undefined;
	try {
		const obj = JSON.parse(line) as Partial<HistoryEntry>;
		if (typeof obj.cwd !== "string" || typeof obj.text !== "string") return undefined;
		return { cwd: obj.cwd, text: obj.text, at: typeof obj.at === "number" ? obj.at : 0 };
	} catch {
		return undefined;
	}
}

function readEntries(file: string): HistoryEntry[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	return raw.split("\n").map(parseLine).filter((e) => e !== undefined);
}

/** Keep the last occurrence of each text, preserving order, capped at `limit`. */
function latestUnique(entries: HistoryEntry[], limit: number): HistoryEntry[] {
	const seen = new Set<string>();
	const kept: HistoryEntry[] = [];
	for (let i = entries.length - 1; i >= 0 && kept.length < limit; i--) {
		if (seen.has(entries[i].text)) continue;
		seen.add(entries[i].text);
		kept.push(entries[i]);
	}
	return kept.reverse();
}

/** This project's prompts, oldest first, without repeats. */
export function loadHistory(file: string, cwd: string, limit = HISTORY_LIMIT): string[] {
	const own = projectKey(cwd);
	// Entries written before a directory was moved behind a symlink still match.
	const keys = new Map<string, string>();
	const keyOf = (dir: string) => keys.get(dir) ?? keys.set(dir, projectKey(dir)).get(dir)!;
	return latestUnique(readEntries(file).filter((e) => keyOf(e.cwd) === own), limit).map((e) => e.text);
}

export function appendHistory(file: string, cwd: string, text: string, now = Date.now()): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	mkdirSync(dirname(file), { recursive: true });
	const entry: HistoryEntry = { cwd: projectKey(cwd), text: trimmed, at: now };
	appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Drop repeats and entries beyond each project's limit once the file is large.
 * Resuming a session replays its prompts into the history, so the file grows
 * faster than the number of distinct prompts. Returns true when it rewrote.
 */
export function compactHistory(file: string, limit = HISTORY_LIMIT, above = COMPACT_ABOVE_LINES): boolean {
	const entries = readEntries(file);
	if (entries.length <= above) return false;
	const byCwd = new Map<string, HistoryEntry[]>();
	for (const e of entries) {
		const list = byCwd.get(e.cwd);
		if (list) list.push(e);
		else byCwd.set(e.cwd, [e]);
	}
	const kept = [...byCwd.values()].flatMap((list) => latestUnique(list, limit)).sort((a, b) => a.at - b.at);
	writeEntries(file, kept);
	return true;
}

function sessionFiles(dir: string): string[] {
	let names: import("node:fs").Dirent[];
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return names.flatMap((n) => {
		const path = join(dir, n.name);
		if (n.isDirectory()) return sessionFiles(path);
		return n.isFile() && n.name.endsWith(".jsonl") ? [path] : [];
	});
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** The user prompts of one pi session file (`{type:"session",cwd}` header, then entries). */
function sessionPrompts(path: string): HistoryEntry[] {
	let cwd: string | undefined;
	const prompts: HistoryEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let obj: { type?: string; cwd?: unknown; timestamp?: unknown; message?: { role?: string; content?: unknown; timestamp?: unknown } };
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type === "session" && typeof obj.cwd === "string" && obj.cwd) cwd = projectKey(obj.cwd);
		if (obj.type !== "message" || obj.message?.role !== "user" || !cwd) continue;
		const text = userText(obj.message.content).trim();
		if (!text) continue;
		const stamp = obj.message.timestamp;
		const at = typeof stamp === "number" ? stamp : Date.parse(String(obj.timestamp)) || 0;
		prompts.push({ cwd, text, at });
	}
	return prompts;
}

export interface ImportResult {
	sessions: number;
	/** Prompts added to the history file. */
	added: number;
	projects: number;
	/** Prompts left out because their project directory no longer exists. */
	skippedMissingCwd: number;
}

/**
 * Merge the user prompts of pi's saved sessions into the history file, ordered
 * by time. Running it again adds nothing. Sessions of directories that no
 * longer exist (temporary test projects) are left out.
 */
export function importSessions(file: string, sessionsDir: string): ImportResult {
	const existing = readEntries(file).map((e) => ({ ...e, cwd: projectKey(e.cwd) }));
	const key = (e: HistoryEntry) => `${e.at}\0${e.cwd}\0${e.text}`;
	const known = new Set(existing.map(key));
	const cwdExists = new Map<string, boolean>();
	const files = sessionFiles(sessionsDir);
	const fresh: HistoryEntry[] = [];
	let skippedMissingCwd = 0;
	for (const path of files) {
		for (const entry of sessionPrompts(path)) {
			if (!cwdExists.has(entry.cwd)) cwdExists.set(entry.cwd, existsSync(entry.cwd));
			if (!cwdExists.get(entry.cwd)) {
				skippedMissingCwd++;
			} else if (!known.has(key(entry))) {
				known.add(key(entry));
				fresh.push(entry);
			}
		}
	}
	if (fresh.length > 0) writeEntries(file, [...existing, ...fresh].sort((a, b) => a.at - b.at));
	return { sessions: files.length, added: fresh.length, projects: new Set(fresh.map((e) => e.cwd)).size, skippedMissingCwd };
}
