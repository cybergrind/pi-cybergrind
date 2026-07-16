import type { Component } from "@earendil-works/pi-tui";
import { TOP_LEVEL, type SwitcherItem } from "./switcher.ts";

// SwitcherList — the overlay component shown by /subagent-switch and Alt+S.
//
// Kept in its own file (and depending on pi-tui via `import type` only) so the
// handleInput state machine is unit-testable without booting a TUI.
//
// Items are pulled live via `getItems()` on every render/input so the overlay
// reflects pool changes (e.g., a row closed with `x` disappears, a newly
// spawned agent appears) without the overlay needing to track them itself.

export class SwitcherList implements Component {
	private selected = 0;
	private readonly getItems: () => SwitcherItem[];
	private readonly done: (value: string | undefined) => void;
	private readonly onClose: (value: string) => void;
	private readonly requestRender: () => void;

	constructor(
		getItems: () => SwitcherItem[],
		done: (value: string | undefined) => void,
		onClose: (value: string) => void,
		requestRender: () => void,
	) {
		this.getItems = getItems;
		this.done = done;
		this.onClose = onClose;
		this.requestRender = requestRender;
		const focused = getItems().findIndex((i) => i.focused);
		if (focused >= 0) this.selected = focused;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const items = this.getItems();
		this.clampSelection(items.length);
		const w = Math.max(10, width);
		const clip = (s: string) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
		const lines = [clip("Subagents  ↑↓ move · ⏎ focus · x close · esc cancel"), ""];
		items.forEach((item, i) => {
			const cursor = i === this.selected ? "▸ " : "  ";
			const here = item.focused ? "◆ " : "  ";
			lines.push(clip(`${cursor}${here}${item.label}`));
			if (i === this.selected && item.detail) lines.push(clip(`       ${item.detail}`));
		});
		return lines;
	}

	handleInput(data: string): void {
		const items = this.getItems();
		this.clampSelection(items.length);
		switch (data) {
			case "\x1b": // esc / ctrl+[
				this.done(undefined);
				return;
			case "\r":
			case "\n":
				this.done(items[this.selected]?.value);
				return;
			case "\x1b[A": // up
			case "\x10": // ctrl+p
			case "k":
				this.move(-1, items.length);
				return;
			case "\x1b[B": // down
			case "\x0e": // ctrl+n
			case "j":
				this.move(1, items.length);
				return;
			case "x":
			case "X": {
				const item = items[this.selected];
				if (!item || item.value === TOP_LEVEL) return; // cannot close yourself
				this.onClose(item.value);
				this.requestRender();
				return;
			}
		}
	}

	private move(delta: number, n: number): void {
		if (n === 0) return;
		this.selected = (this.selected + delta + n) % n;
		this.requestRender();
	}

	private clampSelection(n: number): void {
		if (this.selected >= n) this.selected = Math.max(0, n - 1);
		if (this.selected < 0) this.selected = 0;
	}
}
