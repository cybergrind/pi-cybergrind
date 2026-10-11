import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, compactHistory, importSessions, loadHistory } from "../extensions/lib/prompt-history.ts";

function withFile(fn: (file: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "prompt-history-"));
	try {
		// A nested path: the store creates missing directories.
		fn(join(dir, "agent", "prompt-history.jsonl"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("prompt history store", () => {
	test("missing file → empty history", () => {
		withFile((file) => assert.deepEqual(loadHistory(file, "/a"), []));
	});

	test("prompts come back oldest first, per project", () => {
		withFile((file) => {
			appendHistory(file, "/a", "one", 1);
			appendHistory(file, "/b", "other project", 2);
			appendHistory(file, "/a", "two", 3);
			assert.deepEqual(loadHistory(file, "/a"), ["one", "two"]);
			assert.deepEqual(loadHistory(file, "/b"), ["other project"]);
			assert.deepEqual(loadHistory(file, "/c"), []);
		});
	});

	test("cwd is compared after normalising", () => {
		withFile((file) => {
			appendHistory(file, "/a/b/../c/", "x", 1);
			assert.deepEqual(loadHistory(file, "/a/c"), ["x"]);
		});
	});

	test("a repeated prompt keeps only its latest position", () => {
		withFile((file) => {
			for (const [i, text] of ["one", "two", "one", "three"].entries()) appendHistory(file, "/a", text, i);
			assert.deepEqual(loadHistory(file, "/a"), ["two", "one", "three"]);
		});
	});

	test("limit keeps the newest prompts", () => {
		withFile((file) => {
			for (let i = 0; i < 10; i++) appendHistory(file, "/a", `p${i}`, i);
			assert.deepEqual(loadHistory(file, "/a", 3), ["p7", "p8", "p9"]);
		});
	});

	test("text is trimmed, blank text is not stored, multi-line text survives", () => {
		withFile((file) => {
			appendHistory(file, "/a", "   ", 1);
			appendHistory(file, "/a", "  line one\nline two  ", 2);
			assert.deepEqual(loadHistory(file, "/a"), ["line one\nline two"]);
		});
	});

	test("malformed lines are skipped", () => {
		withFile((file) => {
			appendHistory(file, "/a", "good", 1);
			writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"cwd":1,"text":"bad"}\n\n`);
			appendHistory(file, "/a", "also good", 2);
			assert.deepEqual(loadHistory(file, "/a"), ["good", "also good"]);
		});
	});

	test("the file is private to the user", () => {
		withFile((file) => {
			appendHistory(file, "/a", "x", 1);
			assert.equal(statSync(file).mode & 0o077, 0);
		});
	});

	test("compaction leaves a small file alone", () => {
		withFile((file) => {
			appendHistory(file, "/a", "x", 1);
			assert.equal(compactHistory(file), false);
			assert.equal(compactHistory(join(file, "missing")), false);
		});
	});

	test("compaction drops repeats and overflow per project, keeping order", () => {
		withFile((file) => {
			let at = 0;
			for (let round = 0; round < 3; round++) {
				for (const text of ["a1", "a2", "a3"]) appendHistory(file, "/a", text, ++at);
				appendHistory(file, "/b", "b1", ++at);
			}
			const before = loadHistory(file, "/a", 2);
			assert.equal(compactHistory(file, 2, 5), true);
			assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
			assert.deepEqual(loadHistory(file, "/a", 2), before);
			assert.deepEqual(loadHistory(file, "/a"), ["a2", "a3"]);
			assert.deepEqual(loadHistory(file, "/b"), ["b1"]);
			assert.equal(statSync(file).mode & 0o077, 0);
		});
	});
});

describe("prompt history import", () => {
	function session(dir: string, name: string, cwd: string, messages: Array<[role: string, content: unknown, at: number]>): void {
		mkdirSync(dir, { recursive: true });
		const lines = [
			{ type: "session", version: 3, id: name, cwd },
			{ type: "model_change", id: "m" },
			...messages.map(([role, content, at]) => ({ type: "message", message: { role, content, timestamp: at } })),
		];
		writeFileSync(join(dir, `${name}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
	}

	test("merges session prompts by time, once, and skips vanished projects", () => {
		const root = mkdtempSync(join(tmpdir(), "prompt-history-import-"));
		try {
			const project = join(root, "project");
			const link = join(root, "link");
			mkdirSync(project);
			symlinkSync(project, link);
			const sessions = join(root, "sessions");
			const file = join(root, "prompt-history.jsonl");

			session(join(sessions, "--a--"), "s1", project, [
				["user", [{ type: "text", text: "first" }, { type: "image", data: "x" }], 10],
				["assistant", [{ type: "text", text: "answer" }], 11],
				["user", "third", 30],
			]);
			// The same project, reached through a symlink.
			session(join(sessions, "--b--"), "s2", link, [["user", "second", 20], ["user", "  ", 21]]);
			session(join(sessions, "--gone--"), "s3", join(root, "gone"), [["user", "lost", 5]]);
			appendHistory(file, project, "typed after the sessions", 40);

			const r = importSessions(file, sessions);
			assert.deepEqual(r, { sessions: 3, added: 3, projects: 1, skippedMissingCwd: 1 });
			assert.deepEqual(loadHistory(file, project), ["first", "second", "third", "typed after the sessions"]);
			assert.deepEqual(loadHistory(file, link), loadHistory(file, project));
			assert.equal(statSync(file).mode & 0o077, 0);

			assert.equal(importSessions(file, sessions).added, 0);
			assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 4);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no sessions directory → nothing happens", () => {
		withFile((file) => {
			assert.deepEqual(importSessions(file, join(file, "nope")), { sessions: 0, added: 0, projects: 0, skippedMissingCwd: 0 });
		});
	});
});
