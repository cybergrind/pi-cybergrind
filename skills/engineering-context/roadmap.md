# Roadmap — Proposals for Extending the CE Harness

Trimmed from the project design doc. Read when the user asks to *design or extend* the CE harness, not when running a routine CE pass. Not loaded by default.

## Architecture

1. **CE is a *role*, not a coder.** Editable: context artefacts only (`CLAUDE.md`, `AGENTS.md`, `docs/`, `conftest.py` fixtures/comments, docstrings, comments, `.claude/commands/`, skills, memory files). Application code is off-limits.

2. **Five sub-modes**:
   - **CE-Auditor** — read-only. Analyses transcripts, commits, diffs, and current repo state. Produces reports.
   - **CE-Pruner** — removes low-signal comments, stale docs, redundant instructions, dead skills. Always opens a PR.
   - **CE-Writer** — adds new context based on Auditor findings or recent diffs.
   - **CE-Locator** — given a piece of insight, decides where it should live.
   - **CE-Reviewer** — checks proposed CE changes for anti-patterns.

3. **One umbrella command** (e.g. `pi ce <subcommand>`) wraps `audit`, `prune`, `write`, `locate`, `review`, `compact-memory`, `session-replay`.

## Inputs CE mode should learn from

4. **Session transcript mining** (`~/.claude/projects/.../*.jsonl`):
   - Same file re-read >N times → top-of-file docstring candidate.
   - Agent went down a wrong path → inline comment candidate.
   - Recurring user corrections → `CLAUDE.md` or feedback memory candidate.
   - Tool calls that consistently bloated context → tool-wrapper truncation.
   - Repeated grep/find sequences with same target → slash command or skill.

5. **Git history mining**. High-churn files with many small "fix" commits or reverted diffs are where context investment pays off.

6. **Diff-driven comment proposals**. Run CE-Writer on a freshly-merged PR diff: *what did we learn that future-reader-of-this-file should know, and where exactly?* Cheapest moment to capture insight.

## Measurement and feedback loop

7. **Context budget report** per session: breakdown by the eight slots from background.md, plus tokens from each loaded file. Shows what's actually consuming the window.

8. **Quality signals to track over time**:
   - First-attempt success rate on similar tasks before/after CE changes.
   - Re-reads per session (lower is better).
   - Tool calls per completed task.
   - User-correction frequency in transcripts.
   - Window-utilisation percentage at task completion (target <60%).

9. **Backwards A/B**: when a CE change lands, replay a sample of recent transcripts against the new context in a sub-agent harness and check whether they would have succeeded faster.

## Content rules (the ones already enforced in SKILL.md)

10. **Locality of use** — insight at the most specific scope where it's still useful.
11. **Pointer over inline** in `CLAUDE.md` / `AGENTS.md` unless under 5 lines.
12. **WHY-only comments** — delete restatements of *what*.
13. **No false certainty** in LLM instructions.
14. **Single source of truth** — same fact must not live in two places.
15. **Append-and-link, don't rewrite** (from ACE) — guards against context collapse.

## Operational patterns

16. **Phase commands**: project-local `/research`, `/plan`, `/implement` slash commands. Each starts a sub-agent with a clean window and writes its artefact to `docs/ce/sessions/`.

17. **`thoughts/` or `docs/ce/sessions/` directory** for per-task research/plan artefacts. Plain text, indexed by date+slug. Gitignored by default, optionally committed for important features.

18. **Tool-wrapper layer**. Wrap bloat-prone tools (full-file reads, large JSON returns) with truncation + logging. Truncation events are direct signals for where a comment would help.

19. **Pre-implement plan-review checkpoint**. Human approval of the plan before non-trivial implementation. Review the plan, not the code.

20. **Memory garbage collection**. Periodic CE pass: remove stale entries, merge duplicates, verify referenced paths/functions still exist.

## The two iterative tasks

21. **Iterative task A — the CE prompt itself.** Treat the CE prompt as a living artefact. After each CE session, the Reviewer adds learnings back. Versioned in git so we can A/B over time.

22. **Iterative task B — the CE harness.** Suggested milestones:
    - **M1**: session-transcript analyzer — reports pollution hotspots and missing-context sites.
    - **M2**: comment auditor — low-signal/stale detector + WHY-required check.
    - **M3**: `/research`, `/plan`, `/implement` slash commands and a sessions-directory standard.
    - **M4**: `CLAUDE.md` / `AGENTS.md` linter — length, pointer ratio, false-certainty words, duplicate facts.
    - **M5**: context-budget reporter integrated into session end-of-turn output.
    - **M6**: backwards-A/B harness for CE changes.

## Non-goals

23. Not a style guide — linters and formatters own style.
24. Not "put more in `CLAUDE.md`" — the goal is *less*, in the right place.
25. Not a replacement for code review — plans and CE PRs still need humans.
