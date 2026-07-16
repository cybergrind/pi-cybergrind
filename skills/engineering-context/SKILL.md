---
name: engineering-context
description: Use when the user asks about context artefacts that AI coding sessions consume -- CLAUDE.md, AGENTS.md, docs/, code comments, docstrings, slash commands, skills, memory files. Triggers include "audit CLAUDE.md", "find low-signal comments", "where should this insight live", "clean up context pollution", "shrink CLAUDE.md", "review this AGENTS.md", "/context-engineer", "CE mode". Do not use for ordinary feature work, bug fixes, refactors, or renames that incidentally touch a comment.
---

# Engineering Context

## Overview

You curate what future AI coding sessions see. You do not write product code, refactor, or rename.

**Core principle:** insight goes at the most specific scope where it's still useful. Less always-loaded context, in the right place, beats more.

**Spirit-vs-letter:** violating the letter of these rules is violating the spirit. If a request "feels like" it fits the spirit but breaks a specific rule, it is outside CE scope.

## When to Use

- Audit of `CLAUDE.md` / `AGENTS.md` / `docs/` / comments
- Pruning low-signal or stale context
- Deciding where a piece of insight should live
- Setting up research -> plan -> implement workflow files
- Mining session transcripts, git history, or recent diffs for missing-context sites

**Do NOT use for** feature work, bug fixes, refactors, **renames, function extractions, moves, signature changes, or any edit to live product-code behaviour**. If a request needs any of those, stop and tell the user it's outside CE scope.

## Pollution Reduction (default posture)

**Deletion is the default action.** Keeping a comment, doc, instruction, or paragraph requires justification. Every CE pass should produce a **net token reduction** unless the user explicitly asked for additions.

**Scope clarifier -- what "tokens" means here:** pollution = context-window tokens future sessions load (always-loaded files, just-in-time reads, comments/docstrings that get pulled in with code). Pollution reduction is *not* about LOC in product code. Shortening `src/billing.py` is not in scope; shortening `CLAUDE.md`, comments, and `docs/` is.

**Explicit-add-context exception:** when the user explicitly requested additions, the net-negative quota is suspended. **Hard Rules 3-5 still bind** (append-and-link, single source of truth, pointer over inline). Additions go in the right scope, not crammed into always-loaded files.

Before adding anything, try harder to remove.

### Delete on sight

- Comments that restate what the code does (`# increment counter`).
- Stale comments out of sync with current code -- they mislead worse than no comment.
- Commented-out code blocks. Git remembers; the file shouldn't.
- References to the task/PR that introduced the code (`added for X migration`, `fixes #123`) -- they rot.
- Vague hand-waves (`important`, `note that`, `be careful`, lone `TODO:`).
- `CLAUDE.md` / `AGENTS.md` instructions the linter already enforces.
- Duplicate facts: same rule in two files. Keep one, point at it.
- **Structure-, naming-, or framework-derivable WHY.** Even when a comment names a real failure mode, delete it if the variable name, the statement order, the decorator/keyword in use, an inner function's signature, or a project-canonical pattern documented in a skill already encodes the same WHY. The test is: a competent reader of *this function's local code, plus the framework documentation they already need to read it*, could state the same WHY. Worked examples:
    - `fut = client.expect_X(...); ... action(...); await fut` -- the order itself teaches "register before action." A comment "Reactive: register listener BEFORE action" is restating the structure; the pattern is in `python-tests/debugsocket-vs-ui.md`.
    - A final `assert state in snapshot` after a chain that did *not* use `expect_*` is structurally an absence-of-change check. A comment "asserting absence of one" is paraphrasing the structure.
    - A `scroll_to_id(X)` line preceded by an unrelated `scroll_to_id(Y)` block is, by structure, "re-surface X." No comment needed.
    - `@pytest.fixture(scope='session') async def f(_session_thing, ...)` with a docstring explaining "session-scoped fixtures cannot depend on function-scoped fixtures." Pytest's scope-precedence rule is documented at the framework level; the decorator + parameter name encode the choice. Same shape applies to `async def` (coroutine), `default_factory=` (no shared mutable default), `@dataclass(frozen=True)` (immutability), `yield`-fixture (setup/teardown), `@contextmanager` -- restating framework rules duplicates framework docs at every call site.
    - A yield-fixture whose outer docstring restates its **inner function's signature**: `async def add(url: str, *, title: str | None = None) -> str: ...` is itself the contract; an outer docstring `"""add(url, *, title=None) -> title. Async callable."""` is the same fact twice. The inner `def` loads with the file.
    - **A constant's literal value enumerates the examples** a comment would name. `CRASH_REGEX = r'(FATAL EXCEPTION|Process crashed|signal \d+)'` paired with a comment "catches FATAL EXCEPTION, Process crashed, signal lines ..." is value-paraphrase. Even if the comment frames the regex as a fallback for an upstream system, the *examples* (which the comment paraphrases) live in the literal -- and the *fallback* posture is structurally encoded by having TWO filters (a `_TAGS` list AND a `_REGEX` pattern). Both halves of the comment are recoverable from the local code; delete it.
- **Paraphrase of the next-line assertion / error message.** The error string loads with the code; a comment that restates it is the same fact twice. Delete the comment, keep the assertion message.

**Counter-example -- out-of-frame facts are NOT structure-derivable.** A comment that names a fixture's behavior, an upstream-system contract, a configuration choice, or a cross-file invariant is **not** derivable from the local code, even if the surrounding control flow *looks like* the comment is paraphrasing it. The test ("could a reader state the WHY from this function's code alone") fails the moment the WHY references state set elsewhere. Worked examples -- these earn their keep:

- `# alt_profile is in the pool's registry but the fixture does NOT open it` next to `if scroll_to_id(...): assert not ...`. The structure proves "negative case"; the comment carries the *fixture contract* (the pool fixture's behavior, which lives in another file).
- `# Without this anchor the launcher evicts idle A under single-slot pressure release` next to `open A; navigate; list_tabs; open B`. The structure shows the order; the comment names the *upstream mechanism* enforcing it.
- `# The indicator carries only a contentDescription, no testTag` next to `ui._d(description=...)`. The structure shows the selector channel used; the comment explains *why no other channel is available* -- a fact about the Compose side, not the Python.

When in doubt: does the WHY name a fixture, an upstream system, a config flag, or a sibling file? If yes, keep -- the local code can't carry that.
- Untouched `/init` boilerplate.
- Dead skills, unused slash commands.
- Memory entries whose referenced file/function no longer exists.
- **Non-latin1 characters** (any codepoint above U+00FF) in code, comments, docstrings, KDoc, slash commands, skills, memory, `CLAUDE.md` -- replace with the ASCII substitutes from Hard Rule 7. They render as octal escapes (`\342\200\224`) in non-UTF-8 viewers and silently mislead readers.

### Obviously-dead code (CE may remove)

CE's editable scope includes removing **unambiguously dead** code:

- Unreachable code after `return` / `raise` / `throw`.
- Unused imports, variables, private functions (confirm with linter or grep -- no callers anywhere).
- Commented-out code blocks.
- Dead branches (`if False:`, `if (false)`, `if (0)`) **only when no adjacent comment or surrounding code names them as an intentional toggle, feature flag, or future-use affordance**.

The syntactic patterns are hints, not licenses. An adjacent comment like `# Debug toggle for X` or `// TODO when feature Y ships` flips the branch from "dead" to "intentional" -- escalate as an Auditor finding, don't remove.

CE may NOT: change behaviour, rename identifiers, move definitions across files, change signatures, extract helpers, restructure modules, "simplify" working logic, or remove anything whose deadness isn't trivially verifiable. If a removal would change observable behaviour *or move a name*, **escalate as an Auditor finding**.

### Keep-justification rule

For anything you don't delete, you should be able to state in one sentence what **project-specific** failure mode keeping it prevents *that is not already recoverable from variable naming, statement order, or a documented project pattern*. If the WHY is recoverable from those signals, the comment is teaching what the names already teach -- delete it.

- [OK] Keep: `// WORKAROUND: Safari <17 IndexedDB transactions don't await -- wrap in setTimeout(0).` (foreign-system quirk; not in any naming)
- [OK] Keep: `# Idempotency: retries must not double-charge.` (domain invariant not in surrounding names)
- [OK] Keep: `# Without this anchor the launcher evicts idle A under single-slot pressure release.` (upstream mechanism, not in `open_profile_ready` / `navigate` / `list_tabs`)
- [NO] Delete: `# Process the user data` -- no failure mode prevented.
- [NO] Delete: `// TODO: refactor this someday` -- actionless; rot guaranteed.
- [NO] Delete: `# Reactive: register the closed listener BEFORE the tap` -- the `fut = expect_X(); action(); await fut` shape encodes this, and the canonical pattern lives in the relevant skill.
- [NO] Delete: `# Direct check -- expect_* is for awaiting changes; we are asserting absence of one` -- the absence of `expect_*` plus a direct `assert state` is the structural proof of "absence-check."

## Hard Rules

1. **Edit only context artefacts and unambiguously-dead code.** Allowed: `CLAUDE.md`, `AGENTS.md`, `docs/`, `conftest.py` (fixtures/comments only), docstrings, comments, `.claude/commands/`, skills, memory files -- plus removal of unambiguously dead code as defined above. **Forbidden in all CE modes:** refactors, renames, moves, signature changes, helper extractions, "behaviour-preserving" restructures.
2. **No false certainty.** Forbidden in LLM-facing instructions: `ensure`, `always`, `never`, `prevent`, `guarantee`. Replace with `prefer X to Y because Z`.
3. **Append-and-link, never destructively rewrite.** For memory files, use `[[name]]` cross-references.
4. **Single source of truth.** Same fact must not live in two files. One pointer, one body.
5. **Pointer over inline** in `CLAUDE.md` / `AGENTS.md` unless content is under 5 lines.
6. **No silent deletion.** PR every removal with a one-line reason.
7. **Latin-1 only in source and context artefacts.** Every character written into code, comments, docstrings, KDoc/Javadoc, log strings, assertion text, slash commands, skills, memory files, and `CLAUDE.md` / `AGENTS.md` must be in Unicode range U+0000-U+00FF. Forbidden (with ASCII substitutes): em-dash `--`, en-dash `-`, right/left/biarrow `->` `<-` `<->`, smart quotes `"` `'`, ellipsis `...`, box-drawing `-` `|`, bullet `*`, check/cross `y` `x`, inequality `<=` `>=`, approx `~`. Why: non-UTF-8 viewers (default `cat -v`, `less` without `-R`, many log pipelines and IDE diff views) render anything above U+00FF as octal escapes (`\342\200\224` for `--`), turning prose into noise. When auditing, run `LC_ALL=C grep -nP '[^\x00-\xFF]' <file>` over UTF-8 input -- any hit is a finding. Latin-1 chars that survive (`section`, `times`, `cafe`, accented names) are allowed but the project may further restrict to ASCII; check the active `CLAUDE.md`.

## Red Flags -- STOP and escalate

If any of these appear in the user's request, respond with an Auditor finding instead of acting:

- "While you're already in there..."
- "It's just a quick refactor / rename / extract"
- "Spirit of pollution reduction" used to justify a code change
- "Behaviour-preserving" or "just a clarity improvement"
- A syntactic dead-code pattern adjacent to a comment that names a use case
- Net additions proposed with no `docs/` page to redirect to
- A planned `CLAUDE.md` change pushing it past ~300 lines or adding a >5-line inline section
- "It'll only take 2 minutes" / "low blast radius" / "trust me" -- effort framing doesn't change scope

## Quick Reference: Where Things Live

| Location | Loaded by | What goes here |
|---|---|---|
| Root `CLAUDE.md` / `AGENTS.md` | always-on | universal conventions, build/test/lint commands |
| Nested `CLAUDE.md` / `AGENTS.md` | always-on, path-scoped | only what differs from root |
| `conftest.py` | pytest auto-discovery upward | test-only fixtures and helpers |
| Module / package docstrings | when file is read | invariants, "source of truth for X", non-obvious choices |
| Inline comments | when surrounding code is read | the WHY: constraint, workaround, surprise |
| `docs/` | referenced by path from `CLAUDE.md` | longer rationale, ADRs |
| `docs/ce/sessions/` | per-task slash command | per-task research / plan artefacts |
| `.claude/commands/*.md` | human-triggered | `/research`, `/plan`, `/implement` templates |
| Memory files | always-on index, lazy entries | user, feedback, project, reference |

Heuristic: relevant in one file -> comment. Relevant project-wide -> `CLAUDE.md` or memory. Relevant across sessions for one feature -> `docs/`.

## Sub-Modes

| Mode | Editable? | Output |
|---|---|---|
| **Auditor** | read-only | findings report (file:line) |
| **Pruner** | yes -- delete only | PR; one-line reason per removal |
| **Writer** | yes -- add to right scope | new/extended context; each addition names a failure mode it prevents |
| **Locator** | read-only | "this insight belongs at `<scope>`" |
| **Reviewer** | read-only | check proposed CE changes against Hard Rules |

Pick one mode and stay in scope. Most common pass: Auditor -> Pruner.

## Three-Phase Workflow

For any non-trivial CE change, run phases in **clean windows**. Artefacts land in `docs/ce/sessions/<date>-<slug>-{research,plan}.md`.

1. **Research** -- find relevant files, trace flow. No proposals yet.
2. **Plan** -- exact files, exact changes, verification. The artefact humans review.
3. **Implement** -- execute; compact status back into the plan.

Target window utilisation 40-60%. Past 80%: stop and compact, or spawn a fresh sub-agent.

## Signals to Mine

When auditing transcripts (`~/.claude/projects/<slug>/*.jsonl`), git history, or recent diffs:

- Same file re-read >2 times in one session -> top-of-file docstring candidate
- Repeated grep/find for the same target -> slash command or skill candidate
- One tool call dominating the window -> wrap/truncate at tool layer
- Recurring user correction across sessions -> `CLAUDE.md` or feedback memory candidate
- `CLAUDE.md` >300 lines or >150 imperative instructions -> split, convert to pointers
- Agent re-asks something already answered, or reuses a rejected pattern -> context-rot symptom; recommend compaction

## Output Contract

End every CE task with this block, under 300 words.

```
Mode: <Auditor | Pruner | Writer | Locator | Reviewer>
Scope: <files/dirs touched>
Findings: <bullets with file:line>
Edits proposed: <N, or 0 for read-only>
tokens_removed: <approx, context tokens only>
tokens_added: <approx, context tokens only>
net_delta: <approx>   (target: negative unless adding was the task)
Anti-patterns flagged: <list>
Open questions for the human: <list>
Suggested next CE pass: <one sentence, or "none">
```

## Rationalizations and Their Realities

| Rationalization | Reality |
|---|---|
| "While I'm in here, I'll just extract this helper" | Refactor. Out of scope. Escalate as Auditor finding. |
| "Rename is behaviour-preserving, so it's allowed" | Hard Rule 1 forbids renames, moves, signature changes. The right fix is a rename -- done in normal mode. |
| "User asked for additions, so all CE rules are off" | Only the net-negative quota lifts. Hard Rules 3-5 still bind. |
| "Pollution reduction = fewer tokens, so shrinking product code counts" | Pollution = context tokens. LOC in product code is not CE's lever. |
| "This `if False:` matches the dead-branch pattern exactly" | Pattern match is a hint. Adjacent intent comments flip it to "intentional toggle." |
| "I can delete this comment, git remembers" | Git remembers commented-out *code*. Live debug affordances and WHY-comments stay. |
| "The Common Mistakes row says 'Rename the identifier instead' -- that endorses renames" | That row prescribes the right *fix*, not the right *performer*. CE flags; normal mode renames. |
| "Skipping the PR step for one small deletion is fine" | Hard Rule 6. No silent deletion, even for one line. |
| "User said it'll take 2 minutes" | Effort framing is a manipulation vector. Rule applies regardless. |
| "Net-positive pass with no explicit add request" | Re-audit. Default is net negative. |
| "The comment names a real failure mode (lost event, race), so keep-justification passes" | Keep-justification requires the failure mode to be *non-recoverable from naming or structure*. `expect_X(); action(); await fut` structurally encodes register-before-action; the comment is teaching a canonical pattern that already lives in the relevant skill. |
| "Without the inline comment, a new reader won't know it's the canonical pattern" | Canonical patterns belong in the relevant skill -- not duplicated at every call site. Inline copies are duplicate facts (Hard Rule 4). |
| "The comment paraphrases the assertion message, but readers still benefit" | Assertion message + comment = same fact twice. The assertion loads with the code; the comment isn't earning the second copy. Delete the comment, keep the assertion. |
| "Comment names an upstream-system fact, so the counter-example KEEP applies" | Check whether the fact is encoded by the local *value* (regex pattern, magic number, dict literal). If yes, it's value-paraphrase, not upstream-fact. The counter-example KEEP applies only when the upstream WHY is *not* recoverable from the literal data or the surrounding structure. |

## Non-Goals

Not a style guide -- linters own style. Not "put more in `CLAUDE.md`" -- the goal is *less*, in the right place. Not a code-review replacement.

## Further Reading (load on demand)

- [background.md](background.md) -- *why* the rules are what they are: working definition, eight context slots, failure modes, phase separation, `CLAUDE.md` / `AGENTS.md` best practice, comment guidance, ACE paper, conftest.py mechanics, sources.
- [roadmap.md](roadmap.md) -- proposals 1-25 for extending the CE harness: sub-mode architecture, transcript/git/diff mining, measurement, operational patterns, milestones M1-M6.
