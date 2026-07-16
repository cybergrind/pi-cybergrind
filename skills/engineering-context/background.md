# Background — Why the CE Rules Are What They Are

Trimmed from the project design doc. Read on demand when you need to justify, extend, or contextualise a rule in `SKILL.md`. Not loaded by default.

## Working definition

Context engineering is the discipline of deciding **what** goes into the model's window, **where** that material physically lives in the repo, and **what mechanism** puts it there at the right moment.

- Anthropic: *find the smallest set of high-signal tokens that maximises the desired outcome.* The window is finite working memory with diminishing returns, not free real estate.
- Martin Fowler: every piece of context has an answer to *"who triggers loading — LLM, human, or harness?"* If you can't answer that, it's misfiled.
- Phil Schmid / Neo4j: prompt engineering = one string. Context engineering = the *system* that decides what instructions, retrieved knowledge, memory, tools, observations, and constraints reach the model at each turn.

## The eight context slots

Every piece of context classifies as exactly one of these. If it doesn't, it's misfiled.

1. System / behavioural instructions — `CLAUDE.md`, `AGENTS.md`, agent definitions.
2. User prompt — out of CE scope.
3. Short-term state — current plan, scratch notes.
4. Long-term memory — memory files.
5. Retrieved knowledge — file reads, grep, MCP responses, doc fetches.
6. Tools and their descriptions.
7. Reasoning history / observations — prior tool calls in the transcript.
8. Output constraints — schemas, length caps.

Audit signal: per task, which slots are over-fed (pollution) or under-fed (missing context)?

## Two failure modes

- **Pollution** (spatial): the window contains material irrelevant to the current task.
- **Rot** (temporal): as a session lengthens, early high-signal tokens get effectively deprioritised; the model anchors on recent low-signal noise.

Mitigations the literature converges on:
- Just-in-time retrieval over upfront dumping (Anthropic). Pass paths, not contents.
- Sub-agents with clean windows return 1–2k-token structured summaries (Anthropic, HumanLayer, MindStudio).
- **Frequent Intentional Compaction** (HumanLayer): keep window utilisation at 40–60% by phase-based work. Never drift toward 90%.
- Session hygiene: fresh session per discrete task; persist findings in files, not in long-running threads.
- Tool-output discipline: truncate/filter at the tool layer.

## Phase separation (HumanLayer's "advanced CE")

1. **Research** — clean window, find files, trace flow. Output: a research note.
2. **Plan** — clean window seeded only with the research note. Output: exact files + verification.
3. **Implement** — execute the plan, compacting status back into it.

Corollaries:
- Review the plan, not the code. A bad line in a plan becomes hundreds of bad lines of code.
- Discarding prompts is like throwing away source and checking in the binary. Plans and research notes are source artefacts; commit them.

## CLAUDE.md / AGENTS.md best practice

- `CLAUDE.md` under ~300 lines; HumanLayer's own is under 60.
- Frontier models follow ~150–200 instructions reliably; beyond that, instruction-following decays.
- What belongs: WHAT (stack, structure), WHY (component purposes), HOW (build/test/lint commands).
- What does NOT belong: style rules (linter's job), task-specific instructions, untouched `/init` output, hotfix bandaids.
- Progressive disclosure: pointers cost ~1 line; inlined content costs hundreds.
- AGENTS.md is the cross-tool standard. If both exist, make `CLAUDE.md` a one-line pointer to `AGENTS.md`.
- Recommended `AGENTS.md` sections: Dos/Don'ts, file-scoped commands (lint/typecheck per file, not full builds), safety/permissions, project-structure hints, good/bad example file paths, API doc references, PR checklist, escape hatches.

## Code comments (Glean synthesis)

Helpful: the WHY, algorithm rationale, compliance/domain constraints, integration notes, hidden invariants, workarounds for specific bugs.

Harmful (delete on sight):
- Restatements of syntax (`# increment counter`).
- Stale comments out of sync with current code — they *mislead*, worse than no comment.
- Vague hand-waves.
- References to the original task/PR ("added for the X migration") — they rot.

Comment presence/absence significantly influences whether developers accept AI-generated code. Comments shape trust, not just behaviour.

## ACE paper (Agentic Context Engineering, arXiv 2510.04618)

Treats context as an *evolving playbook* that accumulates, refines, and organises strategies — not a static prompt.

Two failure modes for our memory and CE notes:
- **Brevity bias** — repeatedly summarising loses domain insights.
- **Context collapse** — iterative rewrites erode detail until the document is generic.

Methodology: **Generate → Reflect → Curate** with *structured incremental updates that preserve detailed knowledge*. Reports +10.6% on agent benchmarks, +8.6% on finance tasks, without labeled supervision.

Implication: append-and-link with cross-references beats destructive rewrites.

## Conftest.py mechanics (the canonical analogue for path-scoped context)

- Auto-discovered upward through the directory tree; no imports.
- Each directory's `conftest.py` adds to (or overrides) ancestor fixtures.
- Tests climb upward; they cannot reach into siblings/descendants.
- First match wins on upward search.

This is the pattern we want for non-test context too: nested `CLAUDE.md`, nested `AGENTS.md`, package-level docstrings. Context that's automatically present whenever you're working in this subtree, and nowhere else.

## Open questions

- How do you measure context quality automatically? Token count, time-to-success, edit churn are all weak proxies.
- How much always-loaded vs. just-in-time? Depends on task — may need per-task profiles.
- When is insight better as a comment vs. memory vs. a doc? Heuristic: locality of use.
- How do we avoid memory and CE notes themselves becoming polluted? ACE's brevity-bias problem applies to *us* too.

## Sources

- Anthropic — *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Martin Fowler — *Context Engineering for Coding Agents*: https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html
- HumanLayer — *Advanced Context Engineering for Coding Agents* (ACE-FCA): https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md
- HumanLayer — *Writing a good CLAUDE.md*: https://www.humanlayer.dev/blog/writing-a-good-claude-md
- Builder.io — *AGENTS.md*: https://www.builder.io/blog/agents-md
- Neo4j — *Context Engineering vs Prompt Engineering*: https://neo4j.com/blog/agentic-ai/context-engineering-vs-prompt-engineering/
- Phil Schmid — *The New Skill in AI is Not Prompting, It's Context Engineering*: https://www.philschmid.de/context-engineering
- Liip — *Preventing Context Pollution for AI Agents*: https://www.liip.ch/en/blog/preventing-context-pollution-for-ai-agents
- MindStudio — *Context Rot in AI Coding Agents*: https://www.mindstudio.ai/blog/context-rot-ai-coding-agents-how-to-prevent
- Glean — *How AI assistants interpret code comments*: https://www.glean.com/perspectives/how-ai-assistants-interpret-code-comments-a-practical-guide
- arXiv 2510.04618 — *Agentic Context Engineering (ACE)*: https://arxiv.org/abs/2510.04618
- pytest fixtures reference (conftest.py discovery): https://docs.pytest.org/en/stable/reference/fixtures.html
