# pi-cybergrind

Personal [pi](https://github.com/badlogic/pi-mono) extension package and keybinding overrides.
Pi source code is located at `../../opensource/pi-mono`

## Layout

```
pi-cybergrind/
├── package.json                # pi-package manifest + devDeps for LSP/typecheck
├── tsconfig.json               # strict TS config for the extensions
├── keybindings.json            # symlinked into ~/.pi/agent/keybindings.json
└── extensions/
    ├── tmux-scroll-compose.ts  # ctrl+u → nvim in tmux popup; scroll pi pane while typing
    ├── subagent.ts             # `subagent` tool + /subagent — one-shot nested pi dispatch
    ├── subagent-switch.ts      # alt+s switcher — focus & talk to interactive subagents
    └── lib/                    # shared runners/registries (pi-runner, run-registry,
                                #   agent-pool, focus-router, rpc-agent-client, switcher)
```

## Install

```bash
git clone git@github.com:cybergrind/pi-cybergrind.git ~/devel/github/pi-cybergrind
cd ~/devel/github/pi-cybergrind

make install                          # symlinks keybindings.json into ~/.pi/agent/
pi install $(pwd)                     # registers this package with pi
npm install                           # devDeps for LSP / type-checking
```

Then `/reload` in pi.

`make status` shows the current symlink state. `make uninstall` removes the symlink (and restores any backup `make install` displaced).

## Development — TypeScript LSP

`npm install` pulls `typescript`, `typescript-language-server`, `@types/node`, and the pi-coding-agent types into `node_modules/`. Use whichever editor integration matches your setup.

### Quick checks

```bash
npm run typecheck     # tsc --noEmit against tsconfig.json
```

### nvim (nvim-lspconfig + mason)

If you use [mason.nvim](https://github.com/williamboman/mason.nvim):

```vim
:MasonInstall typescript-language-server
```

…and lspconfig auto-detects the project from `tsconfig.json` / `package.json`. No further setup needed — it'll use the project-local `typescript` from `node_modules` for tsserver.

### nvim (plain nvim-lspconfig, no mason)

The project ships its own LSP binary, so just point lspconfig at it:

```lua
require("lspconfig").ts_ls.setup({
  cmd = { vim.fn.getcwd() .. "/node_modules/.bin/typescript-language-server", "--stdio" },
})
```

Or rely on the project-local binary being on `PATH` while inside the repo:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
nvim extensions/tmux-scroll-compose.ts
```

### VS Code / Cursor / Zed

These ship their own bundled TypeScript. They'll pick up `tsconfig.json` automatically. To force them to use the project-local `typescript` (matches what `npm run typecheck` uses), add to `.vscode/settings.json`:

```json
{ "typescript.tsdk": "node_modules/typescript/lib" }
```

### Notes

- The pi extension API packages are `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (formerly `@mariozechner/*`). Sources import the new names; `findPiPackageBin()` in `extensions/lib/pi-runner.ts` still probes the old name as a runtime fallback for older installs.
- `tsconfig.json` uses `nodenext` module resolution to match pi-mono's own build. ESM-style `.js` import suffixes are *not* required because `noEmit` is on — this config only powers LSP/typecheck.

## Extensions

### `tmux-scroll-compose.ts`

Inside tmux, binds `ctrl+u` to:

1. Put pi's pane into copy-mode.
2. Open `nvim` in a tmux **popup overlay** at the bottom (20% height, full width, borderless), pre-seeded with the current editor text. Your normal nvim config loads — bindings below are layered on top via `-c "luafile ..."`.
3. Inside that nvim, `ctrl+u` / `ctrl+d` (insert + normal mode) scroll the pi pane via `tmux send-keys -t <pi-pane> -X halfpage-up|halfpage-down` — focus stays in nvim.
4. `<C-[>` / `<Esc>` in normal mode = save + force-quit (`:qa!`). Buffer-local, re-applied on `InsertLeave` so it beats plugin overrides.
5. On nvim exit, pi's editor is **replaced** with the file contents and copy-mode is cancelled.
6. If nvim is killed (SIGKILL), the editor is left untouched and the draft path is shown via `notify` (detected via PID poll).

Uses `display-popup` (not `split-window`) so pi's pane is not resized — preserves pi's tmux scrollback, which would otherwise be wiped by pi's full-redraw-on-resize.

No-op outside tmux. One session at a time. Requires `nvim` on `$PATH` and tmux ≥ 3.2 (for `display-popup`).

### `subagent-switch.ts`

A focus layer over *interactive* subagents — long-lived nested `pi --mode rpc` children you can switch to and chat with (distinct from `subagent.ts`'s one-shot dispatches).

- `/subagent-interactive <task>` spawns an interactive subagent into the pool and kicks off `<task>`.
- **`Alt+S`** (or `/subagent-switch`) opens a floating switcher in the **middle-right** of the screen, listing the top-level session plus every interactive subagent (status glyph, name, last output). `↑↓` / `ctrl+p` `ctrl+n` / `j` `k` move, `⏎` focuses, `x` closes the selected subagent (terminates and removes it; the top-level row can't be closed), `esc` cancels. The list refreshes live while open.
- While **focused** on a subagent, what you type is delivered into *that* subagent's loop instead of the top level — a fresh prompt when it's idle, a follow-up (appended after the current turn) when it's busy. A widget above the editor shows who has focus.
- **`Esc`** (or `Ctrl+[`) while focused **interrupts** a busy subagent's turn; when the subagent is idle it drops focus back to the top level.
- Slash commands always reach the top level, even while focused, so you can `/subagent-switch` or `Alt+S` to switch or leave at any time. Focus auto-clears if the focused subagent stops.

Dormant inside nested subagents (`PI_SUBAGENT_DEPTH` / `PI_INTERACTIVE_SUBAGENT`) so it never routes input into itself. Inside a sub-agent, `/subagent-abort` means "abort *me*" — it calls `ctx.shutdown()` so this pi exits gracefully and the parent's runner observes the close. Resolves pi via `resolvePiCommand()` — set `PI_CMD` if `pi` is a shell alias or wrapper rather than a binary on `PATH`.

Smoke-test the live loop against a real pi: `npm run test:interactive` (honors `PI_CMD`).

## Keybindings

`keybindings.json` does the following:

- Strips `ctrl+d` from every default action (`app.exit`, `tui.editor.deleteCharForward`, `app.session.delete`, `app.tree.filter.default`).
- Strips `ctrl+u` from `tui.editor.deleteToLineStart` and `app.tree.filter.userOnly` so the `tmux-scroll-compose` extension can claim it cleanly.
- Adds emacs-style `ctrl+p` / `ctrl+n` to `tui.select.up` / `tui.select.down` for select-list navigation.

`alt+s` (subagent switcher) and `ctrl+u` (tmux-scroll-compose) are claimed by the extensions themselves via `registerShortcut`, not configured here. `alt+s` is used because pi reserves most `ctrl+<letter>` chords for built-ins (e.g. `ctrl+g` = open external editor).
