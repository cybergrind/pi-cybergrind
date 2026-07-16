# Update pi to v0.80.7 and migrate pi-cybergrind plugins — Digest

**Goal:** Update local pi from `v0.79.10` to `v0.80.7` and migrate `pi-cybergrind` imports from `@mariozechner/*` to `@earendil-works/*`.

**Current State:**
- Runtime pi: `/home/kpi/devel/opensource/pi-mono` at `v0.79.10`, with local changes.
- Dev pi: `/mnt/extra/1000/devel/opensource/pi-mono` at `v0.79.10`.
- Upstream: `origin/main` at `v0.80.7` (306 commits ahead).
- `pi-cybergrind` declares `@earendil-works/pi-coding-agent: 0.79.10` but imports from `@mariozechner/*` (v0.73.1). It also has uncommitted WIP.

**Key Upstream Changes:**
- v0.80.0: pi-ai root API moved to `/compat`; extension loader still aliases it at runtime.
- v0.80.3: RPC `get_entries`/`get_tree`, `session_info_changed`, `externalEditor` setting.
- v0.80.4: `agent_settled`, `before_provider_headers`, `InlineExtension`, dynamic tool loading.
- v0.80.7: `ModelRuntime` facade; `ModelRegistry.refresh()` is now async.

**Migration Steps:**
1. Stash or commit WIP in both repos; decide which pi clone is canonical (the `pi` alias points to `/home/kpi/devel/opensource/pi-mono`).
2. In runtime pi: `git fetch origin --tags && git checkout v0.80.7`, `npm ci --ignore-scripts`, `npm run check`, smoke-test `./pi-test.sh`.
3. In `pi-cybergrind`: update `package.json` to `@earendil-works/pi-coding-agent: 0.80.7`, add `@earendil-works/pi-tui: 0.80.7`, switch peer dependency to new name, then `npm install --ignore-scripts`.
4. Replace all `@mariozechner/*` imports with `@earendil-works/*` in `extensions/` and `test/`.
5. Run `npm run typecheck`; fix any new API issues (e.g., `ExtensionContext.mode`, async `ModelRegistry.refresh`).
6. Run `npm run test`, then smoke tests with `PI_CMD=/home/kpi/devel/opensource/pi-mono/pi-test.sh`.
7. Interactively verify `/subagent`, `/subagent-interactive`, `Alt+S`, and `ctrl+u` in tmux.
8. Commit changes and update the README.

**Verification:**
- `pi --version` reports `v0.80.7`.
- `npm run typecheck` passes.
- `npm run test`, `test:subagent`, `test:interactive` pass.
- Live `/subagent`, `/subagent-interactive`, `Alt+S`, and `ctrl+u` work.

**Full plan:** `2026-07-16-update-pi-and-plugins.md`
