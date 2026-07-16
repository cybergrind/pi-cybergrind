# Update pi to v0.80.7 and migrate pi-cybergrind plugins

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Bring the local `pi` installation and the `pi-cybergrind` extension package from v0.79.10 to v0.80.7, migrating stale `@mariozechner/*` imports to the current `@earendil-works/*` packages.

**Architecture:** Update the runtime `pi` clone, refresh the plugin's dev dependencies and lockfile, switch extension imports to the renamed packages, run the type checker and smoke tests, then verify interactively.

**Tech Stack:** TypeScript, npm, `node --test`, tmux, pi extension API, pi RPC mode.

---

## Current State

- **Runtime pi clone:** `/home/kpi/devel/opensource/pi-mono` (used by the `pi` alias via `pi-test.sh`) is at `v0.79.10` with local changes.
- **Dev pi clone:** `/mnt/extra/1000/devel/opensource/pi-mono` is also at `v0.79.10` with local changes.
- **Upstream:** `origin/main` is at tag `v0.80.7` (306 commits after v0.79.10).
- **pi-cybergrind:** `/mnt/extra/1000/devel/github/pi-cybergrind` depends on `@earendil-works/pi-coding-agent: 0.79.10` but its sources still import from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` (v0.73.1). It also has uncommitted WIP.
- **Secrets:** `pi-cybergrind/.envrc` is a symlink and loads `KIMI_API_KEY` for smoke tests. Do not commit it.

Key upstream changes that touch extensions (see `packages/coding-agent/CHANGELOG.md`):
- v0.80.0: pi-ai root entrypoint moved to `@earendil-works/pi-ai/compat`; extension loader still aliases it at runtime, but source imports should switch.
- v0.80.3: RPC `get_entries`/`get_tree`, `session_info_changed` event, `externalEditor` setting.
- v0.80.4: `agent_settled`, `before_provider_headers`, `InlineExtension`, dynamic tool loading, project-local resources.
- v0.80.7 / Unreleased: `ModelRuntime` facade; `ModelRegistry.refresh()` is now async; `Session{Before,}CompactEvent` gain `reason` and `willRetry`.

The current pi-cybergrind code only uses basic `ExtensionAPI` / `ExtensionContext` methods, so no source rewrite is expected beyond the package rename.

---

## Task 1: Prepare the Repositories

- [ ] **Step 1.1: Decide which pi clone is canonical.**  
  The `pi` alias points to `/home/kpi/devel/opensource/pi-mono/pi-test.sh`, so treat that as the runtime source. Keep `/mnt/extra/1000/devel/opensource/pi-mono` in sync or repoint the alias if the dev clone is canonical.

- [ ] **Step 1.2: Save pi-cybergrind WIP.**  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  git status
  git add -A
  git commit -m "wip: save subagent/switcher work before pi update"
  ```  
  (Alternatively: `git stash push -u -m "pre-pi-update"`.)  
  Note: `git add -A` also picks up the untracked `.pi/`, `.projectile`, `.yamllint`, and `skills/` — review `git status` first and drop anything not meant for the WIP commit. `.envrc` is covered by `.gitignore` (verified with `git check-ignore`), so it will not be staged.

- [ ] **Step 1.3: Save or stash changes in the runtime pi clone.**  
  ```bash
  cd /home/kpi/devel/opensource/pi-mono
  git status
  ```  
  Commit or stash the modified `packages/ai/src/image-models.generated.ts`. Leave untracked files (`.envrc`, `CLAUDE.md`, `FORME.md`, `.#FORME.md`, `prev`) as-is.

- [ ] **Step 1.4: (Optional) Sync the dev mirror.**  
  ```bash
  cd /mnt/extra/1000/devel/opensource/pi-mono
  git fetch origin --tags
  git checkout v0.80.7
  ```

---

## Task 2: Update pi to v0.80.7

- [ ] **Step 2.1: Fetch and check out the release.**  
  ```bash
  cd /home/kpi/devel/opensource/pi-mono
  git fetch origin --tags
  git checkout v0.80.7
  ```

- [ ] **Step 2.2: Install dependencies.**  
  ```bash
  npm ci --ignore-scripts
  ```

- [ ] **Step 2.3: Run the project check.**  
  ```bash
  npm run check
  git status
  ```  
  Expected: passes with no errors. Note that `npm run check` includes `biome check --write`, which can modify files — on a clean tag checkout it should be a no-op, but run `git status` afterward to confirm the detached-HEAD checkout is still clean. Generated files (e.g., `packages/ai/src/image-models.generated.ts`) may change; that is normal.

- [ ] **Step 2.4: Smoke-test the pi binary.**  
  ```bash
  ./pi-test.sh --help
  ./pi-test.sh --version
  ./pi-test.sh -p "Say exactly: ok"
  ```  
  Expected: `--help` and `--version` print usage/version; the prompt returns `ok`.

---

## Task 3: Update pi-cybergrind Dependencies

- [ ] **Step 3.1: Edit `package.json`.**  
  - `devDependencies`:
    - `@earendil-works/pi-coding-agent`: `"0.80.7"`
  - Add to `devDependencies`:
    - `@earendil-works/pi-tui`: `"0.80.7"` (used for `Component` in `SwitcherList`)
  - `peerDependencies`:
    - Replace `@mariozechner/pi-coding-agent: "*"` with `@earendil-works/pi-coding-agent: "*"`, or remove the peer dependency.
  - Do **not** add `typebox` as a direct dependency; it remains a transitive dependency.

- [ ] **Step 3.2: Reinstall from scratch.**  
  A plain `npm install` after removing the `@mariozechner` peer dependency does not reliably prune the old packages from `node_modules`; stale `@mariozechner/*@0.73.1` leftovers would let a missed import still typecheck. Start clean:  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  rm -rf node_modules
  npm install --ignore-scripts
  ```  
  Note: `package-lock.json` is listed in `.gitignore`, so the refreshed lockfile stays local-only (see Step 8.1).

- [ ] **Step 3.3: Verify the installed packages.**  
  ```bash
  cat node_modules/@earendil-works/pi-coding-agent/package.json | grep version
  cat node_modules/@earendil-works/pi-tui/package.json | grep version
  ls node_modules/@mariozechner 2>/dev/null && echo "STALE PACKAGES PRESENT" || echo "OK: no @mariozechner packages"
  ```  
  Expected: both `@earendil-works` packages report `0.80.7`, and `node_modules/@mariozechner` does not exist.

---

## Task 4: Migrate Source Imports

- [ ] **Step 4.1: Replace stale package imports.**  
  **Exclude `extensions/lib/pi-runner.ts`:** its `findPiPackageBin()` (around line 130) intentionally probes both `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` in `node_modules` as a runtime fallback for older installs — a blanket sed would turn that array into a duplicated entry and silently delete the fallback. `pi-runner.ts` has no `@mariozechner` imports, only this string literal, so excluding the file loses nothing.  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  find extensions test -name '*.ts' -not -name 'pi-runner.ts' -exec sed -i \
    -e 's|@mariozechner/pi-coding-agent|@earendil-works/pi-coding-agent|g' \
    -e 's|@mariozechner/pi-tui|@earendil-works/pi-tui|g' {} +
  ```

- [ ] **Step 4.2: Verify no stale references remain.**  
  ```bash
  grep -Rn '@mariozechner' extensions test
  ```  
  Expected: exactly one match — the intentional dual-name fallback array in `extensions/lib/pi-runner.ts` (`findPiPackageBin`). Any other match is a missed import.

- [ ] **Step 4.3: Update `README.md` import note.**  
  Replace the note that says both package names still work with a statement that the package now uses `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

---

## Task 5: Typecheck and Adapt to API Changes

- [ ] **Step 5.1: Run the type checker.**  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  npm run typecheck
  ```  
  Expected: passes. If it fails, inspect the errors.

- [ ] **Step 5.2: Fix likely v0.80.x issues if they appear.**  
  The current code only uses basic extension APIs, so changes are expected to be minimal. Common fixes:
  - `ExtensionContext` now has `mode: ExtensionMode` and `isProjectTrusted()`. Runtime provides these; only update test mocks if you construct contexts manually.
  - `ModelRegistry.refresh()` is now async. The current code does not call it.
  - `SessionBeforeCompactEvent` / `SessionCompactEvent` have new `reason` and `willRetry` fields. The current code does not handle these events.
  - If you import from `@earendil-works/pi-ai` directly, use the `/compat` entrypoint for the old global API or migrate to `createModels()`.

- [ ] **Step 5.3: Re-run typecheck after fixes.**  
  ```bash
  npm run typecheck
  ```  
  Expected: passes.

---

## Task 6: Run Tests

- [ ] **Step 6.1: Run unit tests.**  
  ```bash
  npm run test
  ```  
  Expected: all tests pass.

- [ ] **Step 6.2: Run subagent smoke test.**  
  Ensure `KIMI_API_KEY` is loaded (via `direnv` or `export`).  
  ```bash
  PI_CMD=/home/kpi/devel/opensource/pi-mono/pi-test.sh npm run test:subagent
  ```  
  Expected: output ends with `[smoke] PASS`.

- [ ] **Step 6.3: Run interactive subagent smoke test.**  
  ```bash
  PI_CMD=/home/kpi/devel/opensource/pi-mono/pi-test.sh npm run test:interactive
  ```  
  Expected: output ends with `[smoke] PASS`.

- [ ] **Step 6.4: Capture diagnostics if a smoke test fails.**  
  Verify `PI_CMD` resolves to the updated v0.80.7 binary, the API key is present, and the child pi starts without extension-load errors.

---

## Task 7: Interactive Verification in pi

- [ ] **Step 7.1: Register the plugin with the updated pi.**  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  /home/kpi/devel/opensource/pi-mono/pi-test.sh install $(pwd)
  ```

- [ ] **Step 7.2: Reload extensions.**  
  Start `pi` and run `/reload`.

- [ ] **Step 7.3: Verify each extension.**  
  - `/subagent <task>` — nested run completes and result is delivered.
  - `/subagent-interactive <task>` then `Alt+S` — switcher opens, focus changes, and input routes to the subagent.
  - In tmux, press `ctrl+u` — nvim popup opens, scrolls the pi pane, and syncs on exit.
  - Create `.pi/commands/foo.md` and run `/foo` — dynamic command loads.

- [ ] **Step 7.4: Debug startup failures.**  
  If anything fails, restart pi with `pi -ne` to disable extensions and inspect the error.

---

## Task 8: Commit and Document

- [ ] **Step 8.1: Commit pi-cybergrind changes.**  
  `package-lock.json` is listed in `.gitignore`, so do **not** pass it to `git add` — naming an ignored path explicitly makes `git add` fail. The lockfile stays local-only per current repo policy; if you want it tracked instead, remove it from `.gitignore` first as a deliberate policy change.  
  ```bash
  cd /mnt/extra/1000/devel/github/pi-cybergrind
  git add package.json extensions test README.md
  git commit -m "chore: update pi dependency to v0.80.7 and migrate imports"
  ```

- [ ] **Step 8.2: Commit or tag the pi update.**  
  The runtime clone is now on the `v0.80.7` tag with a detached HEAD — that is fine for a tag-pinned install; don't be surprised by `git status` reporting it. No extra commit is needed unless you applied local changes on top.

- [ ] **Step 8.3: Update the plugin README.**  
  Ensure the dependency and install sections reflect `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

---

## Task 9: Optional Enhancements

- [ ] **Step 9.1: Review new extension APIs that could improve the plugins.**  
  - `agent_settled` event — more precise idle point than `agent_end` for subagent pool state.
  - `session_info_changed` event — react to session name changes in the switcher.
  - `before_provider_headers` hook — inject custom headers if needed.
  - `refreshModels(context)` — useful if you register a custom provider.
  - `InlineExtension` — named inline extension factories.

- [ ] **Step 9.2: Adopt `agent_settled` for the subagent pool if desired.**  
  Currently the pool relies on `agent_end` and `message_end`. `agent_settled` may give a cleaner idle signal.

---

## Verification Checklist

- [ ] `pi --version` reports `v0.80.7`.
- [ ] `node_modules/@mariozechner` does not exist, and the only `@mariozechner` reference in sources is the `findPiPackageBin` fallback in `extensions/lib/pi-runner.ts`.
- [ ] `npm run typecheck` in `pi-cybergrind` passes.
- [ ] `npm run test` in `pi-cybergrind` passes.
- [ ] `npm run test:subagent` passes.
- [ ] `npm run test:interactive` passes.
- [ ] `/subagent`, `/subagent-interactive`, `Alt+S`, and `ctrl+u` work in a live pi session.

---

## Notes

- The two pi clones are currently at the same commit. Update the one the alias points to first; keep the other in sync.
- `packages/ai/src/image-models.generated.ts` is a generated file. If it was locally modified, let `npm run check` regenerate it after the update.
- `pi-cybergrind/.envrc` is a symlink to a cloud-backed env file; it should not be edited or committed.
