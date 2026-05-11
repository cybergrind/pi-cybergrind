# pi-cybergrind

Personal [pi](https://github.com/badlogic/pi-mono) extension package and keybinding overrides.
Pi source code is located at `../../opensource/pi-mono`

## Layout

```
pi-cybergrind/
├── package.json          # pi-package manifest
├── keybindings.json      # symlinked into ~/.pi/agent/keybindings.json
└── extensions/
    └── tmux-scroll.ts    # ctrl+u / ctrl+d → tmux copy-mode half-page scroll
```

## Install

```bash
git clone git@github.com:cybergrind/pi-cybergrind.git ~/devel/github/pi-cybergrind
cd ~/devel/github/pi-cybergrind

make install                          # symlinks keybindings.json into ~/.pi/agent/
pi install $(pwd)                     # registers this package with pi
```

Then `/reload` in pi.

`make status` shows the current symlink state. `make uninstall` removes the symlink (and restores any backup `make install` displaced).

## Extensions

### `tmux-scroll.ts`

Inside tmux, binds `ctrl+u` / `ctrl+d` to enter copy-mode and scroll a half page up/down via `tmux send-keys -X halfpage-up|halfpage-down`. Press `q` to leave copy-mode. No-op outside tmux.

## Keybindings

`keybindings.json` does the following:

- Strips `ctrl+d` from every default action (`app.exit`, `tui.editor.deleteCharForward`, `app.session.delete`, `app.tree.filter.default`) so the `tmux-scroll` extension can claim it cleanly.
- Strips `ctrl+u` from `tui.editor.deleteToLineStart` and `app.tree.filter.userOnly` for the same reason.
- Adds emacs-style `ctrl+p` / `ctrl+n` to `tui.select.up` / `tui.select.down` for select-list navigation.
