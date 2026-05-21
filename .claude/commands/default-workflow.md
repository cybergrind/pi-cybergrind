---
description: Standing-order workflow for non-trivial feature/bugfix work — main agent is an orchestrator only; sub-agents do every discrete unit of work; named real-backend smoke tests as the gate; RED/GREEN TDD; tight timeouts. PI-flavored — sub-agents can recursively dispatch sub-agents, so Phase Managers dispatch their workers directly.
argument-hint: short description of the feature or bugfix
---

# /default-workflow

Apply this workflow to the task in `$ARGUMENTS`.

Not a new technique — a fixed sequence anchored by two non-negotiable invariants:

**The Iron Law (correctness gate):** the target test set is named in the plan and green at the gate against the **real backend** at commit time. No `xfail`, no `skip`, no "I'll flag the gap."

**The Orchestration Law (context gate):** the top-level (main) agent is an **orchestrator only**. Every discrete unit of work — context gathering, code reading, design exploration, planning research, RED test authoring, GREEN implementation, build runs, test runs, verification — dispatches to a sub-agent. The main agent's job: pick the role, brief the sub-agent, read its ≤50-line summary, decide next step. Nothing else. The orchestrator's only source of truth about sub-agent work is the sub-agent's **return value** — never log files, pid files, `ps` tables, or partial output streams. Reading those in the main window IS doing the sub-agent's job, even when the intent is "just to figure out what went wrong."

**The Nesting Law (PI flavor):** unlike default Claude Code, **PI sub-agents can themselves dispatch sub-agents**. There is no harness restriction that forces the orchestrator to be the only dispatcher — the `subagent` tool is available inside every child pi session, not just at the top. This means: any phase that loads a skill body, coordinates ≥2 workers, or requires a brief longer than ~20 lines is itself a unit of work — it runs inside a **Phase Manager** sub-agent, and that Phase Manager dispatches its own workers from its own context via the same `subagent` tool. The orchestrator dispatches *phases*; Phase Managers run them end-to-end and return ≤50-line summaries. Each layer talks to the next via a ≤5-line brief in, ≤50-line summary out.

The orchestrator never sees the skill body, never sees the worker briefs, and never sees raw worker output. It sees Phase Manager summaries — that is the entire intake.

## Dispatch mechanism (PI)

There are two surfaces for the same nested-pi runner:

- **`subagent` tool** — the orchestrator LLM calls this directly during a turn. This is the primary mechanism the workflow runs on. The tool spawns `pi -p --mode json --no-session "Task: <brief>"` in a fresh child context, streams live progress to the parent UI, and returns the final assistant text as the tool result. The orchestrator reads that result (≤50-line discipline still applies) and decides the next step.
- **`/subagent <brief>`** — slash command for ad-hoc, user-initiated dispatches from the editor. The result is delivered back to the parent as a user message so the parent agent can react. Use this for manual escape hatches; the orchestration loop itself runs on the tool.

Tool call shape (orchestrator-emitted):

```
subagent({
  task: "<self-contained brief: goal, constraints, return-format. ≤30 lines.>"
})
```

**Pass only `task`.** Do not set `model`, `cwd`, or `extraSystemPrompt` unless the user has explicitly told you to. Overriding `model` silently routes the child to a different provider and fails with "No API key found" when that provider is not configured. Overriding `extraSystemPrompt` silently changes how the child interprets every turn. The right place for per-call behavior is the `task` brief itself.

Brief discipline:
- Self-contained — no references to "see above", no implicit shared context.
- Names artifacts, paths, return format, line budget.
- Sets the success criterion the child must report against.
- ≤30 lines. If the brief grows past that, the dispatch target is a Phase Manager, not a worker.
- All per-call instructions go in `task`. If you find yourself reaching for `extraSystemPrompt` or `model`, stop — the discipline lives in the brief.

Nesting in PI is **recursive both in spirit and in mechanics**: a Phase Manager invokes `subagent(...)` from inside its own context to spawn its workers, then calls `subagent(...)` again to spawn a diagnosis agent if a worker times out, etc. The orchestrator sees one tool call (the Phase Manager), one return (its summary). `PI_SUBAGENT_DEPTH` bounds recursion at 5 levels — well above any expected use.

### What "orchestration only" means concretely

The main agent **may**:
- Dispatch sub-agents (workers or Phase Managers) with a written brief.
- Read sub-agent summaries — hard cap **50 lines**; if a sub-agent returns more, re-brief, do not absorb.
- Run a **bounded inspection-only** Bash from this fixed whitelist (exact forms only, no extra flags):
  - `git status`
  - `git diff --stat` — only if the working-tree diff is known small; for any branch-vs-main diff, dispatch.
  - `git log -<N> --oneline` with `N ≤ 15`. No `--stat`, `-p`, `--name-only`, `--follow`, `--graph`, or any flag that expands per-commit output.
  - `git rev-parse HEAD` / `git rev-parse --abbrev-ref HEAD`
  - `ls <single-dir>` — no `-R`, no shell glob expansion, no piping. **At most one `ls` per workflow phase.**

  Anything outside this whitelist — including a whitelisted command with extra flags — dispatches.
- Apply `Edit` / `Write` **only to allowlisted paths**: `docs/plans/<file>.md`, `docs/sessions/<file>.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/commands/**`, `.claude/skills/**`, `.pi/commands/**`, `.pi/skills/**`.
  - The Edit tool itself enforces "Read before Edit," which is the membership check — don't re-Read these files just to "refresh" them.
  - New files in the allowlist may be authored **only** from material already in the main window via sub-agent summaries; the orchestrator does not Read product code to seed a new plan/session-note file.
  - No other path is editable from the main agent. Not other `docs/` subtrees, not `README.md` files at random tree levels, not `.gitignore`, not config.

  Editing comments or docstrings inside product files (`.py`/`.ts`/`.kt`/`.cc`/etc.) is **never** main-agent work, even when the change is one line — that Edit lands in a product file and would require reading it first. Dispatch.

The main agent **must not**:
- `Read` any product-source file — full stop. There is no size threshold below which a product Read is OK in the main window. Dispatch.
- Run any `Grep` or `Glob` — sub-agent.
- Run any Bash outside the whitelist above — sub-agent. In particular: any test runner, build command, linter, `find`, `ls -R`, and any redirection of build/test output.
- Run the acceptance test set at any gate — Step 7 dispatches a verification sub-agent. The orchestrator never runs the gate itself, even "one last time to confirm green."
- "Just take a quick look" at a file to decide what to do — the decision is a sub-agent's output.
- Author product-code `Edit`s ever, in any step, for any reason. Bug fix one-liners included. Comment/docstring tweaks included.
- Treat user-pasted file paths as license to Read in main — re-brief a sub-agent against the path instead.
- Diagnose a stuck, parked, slow, or silently-returning sub-agent by reading its logs, polling its output file, checking `ps`/`pgrep`, tailing a build log, or any other inspection in the main window. **Diagnosis is itself a sub-agent dispatch.**

If you catch yourself about to Read any product file (one byte or one megabyte), run a Bash outside the whitelist, or Edit any non-allowlisted path, stop and dispatch. The pollution rule has no size floor.

### When a sub-agent stalls, parks, or returns thin

The fastest path from "running /default-workflow" to "main window polluted" is not a flagrant violation. It is: a sub-agent stalls or returns less than expected; the orchestrator peeks at a log or `ps` table *just to figure out what to do next*; then never re-quarantines the work. After that single peek the orchestrator owns the loop, and the workflow has structurally degraded.

Rules for this exact moment — they bind harder than the general "must not" list:

1. **Stuck-for-orchestrator-purposes is the lack of return, not the lack of log activity.** A sub-agent that has not returned in >2 min is stuck for routing purposes. Do not consult a log to confirm.
2. **Diagnosis is a dispatch.** Re-brief a fresh sub-agent with the diagnostic question — read the log, check processes, report cause. The orchestrator never reads those artefacts itself.
3. **Re-brief tighter, never re-brief same-with-longer-timeout.** A timeout is information about scope. Cut scope; do not extend budget.
4. **Foreground over background for verification.** Backgrounding shifts the source of truth from the return value to the log file. If the work is "run the gate and tell me pass/fail," the sub-agent runs the test command in **foreground inside its own context** and returns pass/fail + failing names.
5. **User urgency does not lift the rule.** When the user says *"the test is stuck — find out what is happening"*, the orchestrator's first move is still a sub-agent dispatch (*"user reports stuck; diagnose <run-id>/<log>"*), not a direct `ps`/`tail`/`grep`.

If you catch yourself about to `tail`, `wc -l`, `grep`, `ps`, `pgrep`, `cat` a log, or `sleep N && <read>` to figure out what a sub-agent is doing — stop and dispatch a diagnosis brief.

### Nesting in PI: dispatch phases, not workers

The Orchestration Law forbids the orchestrator from doing work. The Nesting Law extends this: **the work of orchestrating a single phase** — loading the skill that governs the phase, drafting worker briefs, choosing execution mode, handling timeouts and retries — is itself work that pollutes the orchestrator. That work belongs in a **Phase Manager** sub-agent.

In PI this is mechanically straightforward: the Phase Manager loads the skill in its own window, drafts worker briefs in its own window, **dispatches workers directly** from its own context, handles their summaries, re-briefs on failure, and returns one compressed summary upward. The orchestrator never sees worker briefs, worker output, or skill bodies.

This differs from the Claude Code variant of this workflow, where sub-agents cannot use the `Agent` tool and Phase Managers must return a verbatim worker brief for the orchestrator to copy and dispatch. PI has no such constraint — nest freely.

#### Orchestrator → Phase Manager brief (≤5 lines)

Tool call:

```
subagent({
  task: "Run Phase <N>: <one-line goal>. Apply the `<skill-name>` skill in your context. Dispatch whatever workers you need via subagent(...). Return a ≤50-line summary: outcome, key artifacts, named gates passed/failed, recommended next phase. On failure: root cause + tighter scope that might fix it."
})
```

That is the entire brief. Anything richer is the Manager's job to draft inside its own window. If you find yourself drafting a 30-line worker brief at the top, stop — write a 3-line Manager brief and let the Manager author the rich brief.

#### When a Phase Manager is mandatory

Dispatch a Phase Manager (not a worker directly) when ANY trigger fires:

1. **The phase requires loading a skill body.** Skill bodies are pollution — they load into the calling agent's context. Move the load one layer down.
2. **The phase coordinates ≥2 workers**, parallel or sequential. Coordination state belongs in the Manager's window.
3. **The worker brief, written here, would exceed ~20 lines.** Brief authoring is structured thought; it belongs one layer down.
4. **The phase has internal failure modes** (timeout, parked worker, thin return) that may need diagnosis or retry. The Manager owns the diagnosis loop; the orchestrator sees only success/failure.

#### When direct dispatch is OK (narrow carve-out)

Skip the Manager layer ONLY when ALL three hold:
- No skill body load needed by the worker.
- Exactly one worker, brief ≤20 lines.
- No expected coordination, no expected failure handling.

Default: nest. The carve-out is for trivial sweeps.

#### Watch for the failure pattern

If you ever narrate at top level: *"Skill loaded. Dispatching Phase <N> — <execution-mode details>"* — you have already violated the Nesting Law. The skill load was the violation; the dispatch downstream of it is polluted by association. Re-do: write a 3-line brief to a Phase <N> Manager; let *it* load the skill, pick the execution mode, dispatch the worker(s). The orchestrator only sees the Manager's compressed summary.

## When to apply

- Implementing any feature touching ≥2 files
- Any bugfix where the root cause is not obvious from a single Read
- Any change with user-visible behavior

## When NOT to apply (tell the user, then skip)

- One-character typo / string fixes
- Single-line refactors with no behavior change
- Lint-only sweeps

For these, edit + pre-commit/lint is the whole flow.

## The seven steps

### 1. Context prep — sub-agents only

**Zero multi-file analysis in the main agent.** Any context gathering — Reading source, grep'ing for callers, tracing flow, surveying a directory — is a sub-agent dispatch. One sub-agent per area-of-concern, parallel where independent. Each returns a ≤50-line summary; the main agent owns synthesis only.

Default sub-agent role for read-only context sweeps: a fast recon agent (e.g. `scout`). Reserve full-tool worker agents for sub-tasks that must also Edit.

### 2. Architecture — `principled-architecture` skill

If the task introduces a new abstraction, splits/joins components, picks between competing layouts, or chooses a placement seam — apply the `principled-architecture` skill (via a Phase Manager) **before any Edit**. "User said start coding" does not lift this.

### 3. Name the target tests up front

Identify the specific test files (and ideally test names) in the project's integration / smoke suite that must be green at commit. Write them into the plan as the acceptance gate.

Rules:
- New endpoint? At least one integration test exercises it through real HTTP / real backend.
- New UI flow? At least one smoke test drives it end-to-end against the real backend.
- Mock-only tests are **additive**, never **substitutive**.

### 4. Plan — `writing-plans` skill

Apply the `writing-plans` skill via a Phase Manager. Three structural requirements specific to this workflow:

- **`engineering-context` checkpoint after every meaningful step.** Re-survey state via a sub-agent that re-Reads the relevant files and returns a ≤50-line refresh. The main agent does not re-Read product files at checkpoints; the checkpoint is a dispatched action.
- **Sub-agent dispatch called out by name** at the start of each phase that has independent tracks. Don't leave it to inference at execution time.
- **Per-phase green gate.** Every phase ends with a named subset of the target tests green. Not just one gate at the end.

### 5. RED/GREEN TDD

Apply the `test-driven-development` skill via a Phase Manager. RED first in the project's integration suite against the real backend — watch them fail for the right reason. Then minimal code to GREEN.

### 6. Execute — `executing-plans` skill (default: every step is a sub-agent dispatch)

Apply the `executing-plans` skill via a Phase Manager (the Execution Manager). **Default posture: every discrete step is a sub-agent dispatch**, not just phases with parallel tracks. Sequential steps still go to sub-agents one at a time — sequentiality is a scheduling constraint, not a licence to pollute.

For phases with ≥2 independent concurrent steps, the Execution Manager dispatches them in parallel from its own context.

Orchestrator owns: Phase Manager brief, summary intake, decision to advance/retry. Orchestrator does **not** own: any of the step's reads, writes, or test runs — and does not see worker briefs either; those live in the Execution Manager.

No exceptions for product code. The earlier path-allowlist for Edit stands.

### 7. Final gate — `verification-before-completion` skill

Dispatch a Verification Phase Manager to run all target tests from Step 3 against the real backend in **one clean run**, foreground inside its sub-agent's context. The Manager must return:

- exit code of the test command (integer)
- log path on disk (so the orchestrator or user can grep without re-running, via a sub-agent)
- pass count / fail count
- failing-test names as a flat list (≤50 lines total summary)

The main agent never runs the gate itself — not even "one last test run to be sure." Ship/no-ship is decided from the summary; if the summary lacks any of the four required fields, re-brief the Verification Manager (do not run the gate inline to "audit" it). If a test is genuinely flaky (n≥5 evidence, not n=1), apply the `systematic-debugging` skill — `xfail`/`skip` does not ship.

## Tight timeouts

Every test / sub-agent / Bash invocation carries an explicit timeout matched to expected duration. Default: 5 min for test runs, 2 min for sub-agent analysis. **If a timeout fires: kill, diagnose (via a sub-agent), narrow scope.** Never extend a timeout to "let it finish" — that hides regressions and burns session time.

## Red flags — STOP

| Rationalization | Reality |
|---|---|
| "Mock tests are exactly what exists for this layer" | Mock tests are additive, never substitutive. The real-backend gate stands. |
| "A single endpoint ping doesn't justify the real-backend cost" | Then write one cheap real-backend test, not zero. Cost is not the gate's enemy; unverified behavior is. |
| "My honest default is to Read all three files in the main agent" | That is context pollution. Catch yourself before the first multi-file Read. Sub-agents. |
| "Just one Read to confirm what the sub-agent said" | Re-Reading in the main agent defeats the sub-agent's summary. Re-brief the sub-agent — don't duplicate its work in your window. |
| "The file is tiny, I'll just Read it inline" | Tiny today; the next file you justify the same way is bigger. Reads in the main window are how pollution accretes. Dispatch. |
| "Running the test directly is faster than briefing a sub-agent" | The test's output is what pollutes you. The sub-agent absorbs the output and hands back pass/fail + a failing-test list. Speed isn't the metric; orchestration purity is. |
| "Grep is read-only, it's not polluting" | A multi-file Grep dumps every match into the main window. Sub-agent. |
| "I already loaded that skill earlier in the session — reuse what I remember" | Memory of a skill body is unreliable across compactions. Invoke the skill via a Phase Manager when its rules apply; don't paraphrase from memory. |
| "The plan is the orchestrator's job, so I'll write it inline" | Plan **drafting research** goes to a sub-agent (or Phase Manager); the main agent decides what to put in the plan and Edits the plan file. Plan-writing isn't a license to Read product code. |
| "Phase has only one step, no need to dispatch" | Sequential ≠ inline. One-step phases dispatch the one step. Inlining is how Step 6's discipline rots. |
| "These two failing tests are clearly flaky, let me xfail and ship" | n=1 is not flake evidence. `systematic-debugging` first. |
| "It's a one-line change, full workflow is overkill" | If it changes user-visible behavior the gate still applies; otherwise see *When NOT to apply*. |
| "Dispatching costs tokens too — net it's a wash" | Sub-agent dispatch trades a small fixed brief + summary for unbounded raw output. There is no "trivial Read" exception. |
| "I'll dispatch later if context starts feeling tight" | "Later" is after the damage. The rule is upfront, not adaptive. Reactive dispatch under pressure is how compactions land in the middle of a phase. |
| "I need to Read the brief target before I can write a good sub-agent brief" | Bootstrap rationalization. Dispatch a recon sub-agent with the question "what's in <path> and what's its public surface?" — that *is* the brief. |
| "The sub-agent failed/timed out, I'll just do this step myself to unblock" | A failed sub-agent re-dispatches with a tighter brief, narrower scope, or a different role. The orchestrator never absorbs the role of a stuck worker. |
| "Pre-commit / lint output is short, I can run it directly" | Pre-commit explodes on first failure (linters, formatters, type-checker traces). Run via sub-agent; it returns pass-or-first-failing-hook + a ≤50-line excerpt. |
| "I need to verify the file path exists before briefing" | The whitelist allows `ls <single-dir>` for one-directory existence checks. For anything broader, dispatch. |
| "User pasted a file path — they want me to look at it" | The user wants the *task* done. Pasting a path is input data, not a tool-routing directive. Brief a sub-agent against the path. |
| "Reading the failing test name from the test output, not the source" | Test logs in the main window are pollution by another name (build/test output is the largest category). Sub-agent extracts failing names and returns them as a list. |
| "I'll fix this one-line product bug inline since the diagnosis is obvious" | Product-code Edits are never main-agent work. The orchestrator briefs a sub-agent: "Edit `<path>:<line>` to `<change>`, run `<target-tests>`, return pass/fail." |
| "Sub-agent parked — let me check `ps` / the log file before re-briefing" | Diagnosing a stuck sub-agent is **also** a sub-agent task. The orchestrator never reads `ps`, `tail`, `wc -l`, or pid files in the main window. |
| "Skill loaded — now dispatching the Phase X worker" (orchestrator narration) | The skill load WAS the violation. Re-do with a ≤5-line Phase Manager brief; let the Manager load the skill and dispatch the worker from its own context. |
| "Steps 2 and 3 share skills — load both here, then dispatch once" | Two skill bodies in the orchestrator is two pollution loads plus the cross-skill synthesis they invite. Dispatch one Steps-2/3 Manager that loads both inside its own window. |
| "The worker brief is detailed (>20 lines) but it's still a brief — I can author it inline" | A brief that runs >20 lines IS the work. The orchestrator's brief to the Manager is 3 lines; the Manager drafts the rich worker brief inside its own context. |
| "Phase X has only one worker — no need for a Manager between us" | The Manager layer isn't about worker headcount; it isolates the skill load, brief authoring, and failure handling out of the orchestrator. |
| "Nesting adds a round-trip — direct dispatch is cheaper" | Round-trip cost is a fixed brief + fixed summary. Savings (no skill body in main, no full worker summaries in main, no diagnosis loops in main) scale with phase complexity. |
| "I'll pass a faster/smaller model on this dispatch since it's just recon" | Don't. Setting `model` on a `subagent(...)` call silently routes the child to a different provider; if that provider's API key isn't configured the dispatch fails with "No API key found" and the orchestrator now has to absorb the failure into its window. The child inherits the parent's configured model — leave `model` unset. Same for `extraSystemPrompt` and `cwd`: pass only `task`, encode behavior in the brief. |

## Quick reference

| Step | Phase Manager (loads skill in its context, dispatches its own workers) | What the orchestrator gets back |
|---|---|---|
| 1. Context prep | Context Manager (`dispatching-parallel-agents`) | Per-area summaries rolled into ≤50 lines |
| 2. Architecture | Architecture Manager (`principled-architecture`) | Design choice + reasoning (≤50 lines) |
| 3. Target tests | (in plan; no Manager needed) | Named test files in the integration suite |
| 4. Plan | Plan Manager (`writing-plans` + `engineering-context`) | Plan path + per-phase gates headline |
| 5. TDD | TDD Manager (`test-driven-development`) | RED test paths + observed failure modes |
| 6. Execute | Execution Manager (`executing-plans`) | Per-phase pass/fail rolled up to outcome |
| 7. Gate | Verification Manager (`verification-before-completion`) | Exit code, counts, failing test names |

## Self-check before any tool call

Before invoking `Read`, `Grep`, `Glob`, `Bash`, or `Edit` directly, classify against this table. If your action doesn't match a green row exactly, **dispatch**.

| Tool | Green (main agent OK) | Red (always dispatch) |
|---|---|---|
| `Read` | None — main agent does not Read product code or product-adjacent files. For a doc/skill/plan you are Editing, the Edit tool's own Read-before-Edit handles membership; do not re-Read to "refresh." | Any product source. Any test source. Any new file the main agent has not yet opened. Any "refresh" re-Read of a doc you already authored this session. |
| `Grep` / `Glob` | Never. | Always sub-agent. |
| `Bash` | Exact whitelisted forms only — see the "may" list above. | Anything else: build, test, lint, format, run, watch, `find`, `ls -R`, any redirect/pipe/chain (`>`/`>>`/`\|`/`&&`/`;`), any whitelisted command with extra flags, anything expected to produce >20 lines. Any `ps`/`pgrep`/`tail`/`wc`/`head`/`grep` against a sub-agent's output, log path, or process. Any `sleep N && <read>` form (single iteration counts as polling). |
| `Edit` / `Write` | Allowlisted paths only (`docs/plans/<file>.md`, `docs/sessions/<file>.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/commands/**`, `.claude/skills/**`, `.pi/commands/**`, `.pi/skills/**`). New content ≤200 lines per call; no fenced code blocks in product languages — those are sub-agent output, not orchestrator-authored. | Any product code. Any test file. Any comment or docstring *inside* a product file. Any path not in the allowlist. Any allowlisted file containing >200 lines of new content from a single Edit — split or dispatch. |

Three-question gate before pressing the button:
1. Does this call match a green cell exactly (same tool, exact form, allowlisted path)? If no → dispatch.
2. Is the expected output unambiguously short (≤20 lines for Bash, ≤50 lines for a single sub-agent summary you're re-reading)? If you can't predict the length, treat that as a no → dispatch.
3. Does the call touch any product file or test file in any way (Read, Edit a docstring in it, `cat` it, `head` it, `tail` it)? If yes → dispatch.

The doubt itself is the signal. "Almost matches" is a red flag. Self-classification under pressure is exactly the failure mode this gate exists to catch — when you find yourself constructing a justification, the right answer is dispatch.

---

Begin by stating which step you're on and what you're about to do. Do not skip steps without explicitly telling the user why. Before every tool call in the main agent, state the green-cell match in one sentence (e.g. "Bash whitelist: `git status`"). If you cannot, dispatch instead.
