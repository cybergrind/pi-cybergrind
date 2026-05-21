import { describe, test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discover,
	expand,
	firstNonEmptyLine,
	parseFrontmatter,
	tokenize,
} from "../extensions/dynamic-commands.ts";

describe("parseFrontmatter", () => {
	test("no frontmatter → body == input, no fields", () => {
		const r = parseFrontmatter("hello world\nrest");
		assert.equal(r.body, "hello world\nrest");
		assert.equal(r.description, undefined);
		assert.equal(r.argumentHint, undefined);
	});

	test("basic key/value pairs", () => {
		const r = parseFrontmatter("---\ndescription: foo bar\nargument-hint: <task>\n---\nbody here");
		assert.equal(r.description, "foo bar");
		assert.equal(r.argumentHint, "<task>");
		assert.equal(r.body, "body here");
	});

	test("strips matching quotes", () => {
		const r = parseFrontmatter(`---\ndescription: "quoted"\nargument-hint: 'single'\n---\nbody`);
		assert.equal(r.description, "quoted");
		assert.equal(r.argumentHint, "single");
	});

	test("preserves unbalanced quotes verbatim", () => {
		const r = parseFrontmatter(`---\ndescription: "open\n---\nbody`);
		assert.equal(r.description, `"open`);
	});

	test("ignores lines without colons", () => {
		const r = parseFrontmatter("---\njust a sentence\ndescription: real\n---\nbody");
		assert.equal(r.description, "real");
	});

	test("malformed (missing closing ---) → returns input as body", () => {
		const r = parseFrontmatter("---\ndescription: foo\nno closer");
		assert.equal(r.description, undefined);
		assert.ok(r.body.startsWith("---"));
	});

	test("CRLF line endings", () => {
		const r = parseFrontmatter("---\r\ndescription: ok\r\n---\r\nbody");
		assert.equal(r.description, "ok");
		assert.equal(r.body, "body");
	});
});

describe("firstNonEmptyLine", () => {
	test("returns first non-blank line", () => {
		assert.equal(firstNonEmptyLine("\n\n  hi  \nnext"), "hi");
	});
	test("truncates with ellipsis when long", () => {
		const long = "a".repeat(120);
		const out = firstNonEmptyLine(long);
		assert.ok(out!.length <= 81);
		assert.ok(out!.endsWith("…"));
	});
	test("returns undefined for empty/blank input", () => {
		assert.equal(firstNonEmptyLine(""), undefined);
		assert.equal(firstNonEmptyLine("\n\n   \n"), undefined);
	});
});

describe("tokenize", () => {
	test("bare words split on whitespace", () => {
		assert.deepEqual(tokenize("a b  c\td"), ["a", "b", "c", "d"]);
	});
	test("double-quoted preserves spaces", () => {
		assert.deepEqual(tokenize(`a "b c" d`), ["a", "b c", "d"]);
	});
	test("single-quoted preserves spaces", () => {
		assert.deepEqual(tokenize(`a 'b c' d`), ["a", "b c", "d"]);
	});
	test("empty string → []", () => {
		assert.deepEqual(tokenize(""), []);
		assert.deepEqual(tokenize("   "), []);
	});
});

describe("expand", () => {
	test("$1, $2 positional", () => {
		assert.equal(expand("$1 then $2", "foo bar baz"), "foo then bar");
	});
	test("$@ joins all tokens with space", () => {
		assert.equal(expand("all: $@", `a "b c" d`), "all: a b c d");
	});
	test("$ARGUMENTS is raw arg string", () => {
		assert.equal(expand("raw: $ARGUMENTS", "  a  b  c  "), "raw:   a  b  c  ");
	});
	test("${@:N} slices from N (1-indexed)", () => {
		assert.equal(expand("rest: ${@:2}", "a b c d"), "rest: b c d");
	});
	test("${@:N:L} slices L tokens from N", () => {
		assert.equal(expand("mid: ${@:2:2}", "a b c d e"), "mid: b c");
	});
	test("missing positional → empty string", () => {
		assert.equal(expand("a=$1 b=$2 c=$3", "x"), "a=x b= c=");
	});
	test("no args → all expansions become empty", () => {
		assert.equal(expand("[$1][$@][$ARGUMENTS]", ""), "[][][]");
	});
});

describe("discover", () => {
	let projectRoot: string;
	let homeRoot: string;

	before(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "pi-discover-project-"));
		homeRoot = mkdtempSync(join(tmpdir(), "pi-discover-home-"));
	});
	after(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(homeRoot, { recursive: true, force: true });
	});

	function placeCommand(root: string, subdir: string, name: string, body: string): void {
		const dir = join(root, subdir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.md`), body);
	}

	test("empty dirs → no commands", () => {
		const cleanProject = mkdtempSync(join(tmpdir(), "pi-empty-proj-"));
		const cleanHome = mkdtempSync(join(tmpdir(), "pi-empty-home-"));
		try {
			assert.deepEqual(discover(cleanProject, cleanHome), []);
		} finally {
			rmSync(cleanProject, { recursive: true, force: true });
			rmSync(cleanHome, { recursive: true, force: true });
		}
	});

	test("loads .md files with frontmatter and body", () => {
		placeCommand(projectRoot, ".claude/commands", "hello", "---\ndescription: greet\n---\nHi $1");
		const cmds = discover(projectRoot, homeRoot);
		const hello = cmds.find((c) => c.name === "hello");
		assert.ok(hello, "expected hello to be discovered");
		assert.equal(hello!.description, "greet");
		assert.equal(hello!.body.trim(), "Hi $1");
	});

	test("project .pi/commands beats project .claude/commands on name conflict", () => {
		placeCommand(projectRoot, ".claude/commands", "shared", "from claude");
		placeCommand(projectRoot, ".pi/commands", "shared", "from pi");
		const cmds = discover(projectRoot, homeRoot);
		const shared = cmds.find((c) => c.name === "shared");
		assert.ok(shared);
		assert.match(shared!.path, /\.pi\/commands\/shared\.md$/);
	});

	test("project beats global on name conflict", () => {
		placeCommand(projectRoot, ".claude/commands", "g", "project body");
		placeCommand(homeRoot, ".pi/commands", "g", "global body");
		const cmds = discover(projectRoot, homeRoot);
		const g = cmds.find((c) => c.name === "g");
		assert.ok(g);
		assert.ok(g!.path.startsWith(projectRoot));
	});

	test("global commands surface when no project override exists", () => {
		placeCommand(homeRoot, ".claude/commands", "global-only", "g");
		const cmds = discover(projectRoot, homeRoot);
		assert.ok(cmds.find((c) => c.name === "global-only"));
	});

	test("ignores non-.md files", () => {
		const dir = join(projectRoot, ".pi/commands");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "ignore.txt"), "not a command");
		const cmds = discover(projectRoot, homeRoot);
		assert.equal(cmds.find((c) => c.name === "ignore"), undefined);
	});

	test("description falls back to first non-empty line when frontmatter missing", () => {
		placeCommand(projectRoot, ".pi/commands", "barebones", "first line\nrest");
		const cmds = discover(projectRoot, homeRoot);
		const b = cmds.find((c) => c.name === "barebones");
		assert.ok(b);
		assert.equal(b!.description, "first line");
	});
});
