// Pure focus state for the subagent switcher.
//
// "Focus" is which loop your keyboard input drives:
//   - null         → the top-level agent (the normal pi session)
//   - <agent id>   → an interactive subagent in the pool (see ./agent-pool.ts)
//
// This holds no I/O and no timers; it is the testable core of the helper.
// The extension (subagent-switch.ts) owns one instance, points input at
// `current()`, and calls `reconcile()` whenever the pool changes so focus
// never dangles on an agent that has stopped.

export class FocusRouter {
	private focusedId: string | null = null;

	/** The currently focused agent id, or null for the top-level agent. */
	current(): string | null {
		return this.focusedId;
	}

	/** True when input should be routed to a subagent rather than top-level. */
	isFocused(): boolean {
		return this.focusedId !== null;
	}

	/** Point focus at an agent id, or null to return to the top-level agent. */
	focus(id: string | null): void {
		this.focusedId = id;
	}

	/**
	 * Drop focus if the focused agent is no longer among `aliveIds`.
	 * Returns true when focus was cleared (so callers can notify the user).
	 */
	reconcile(aliveIds: Iterable<string>): boolean {
		if (this.focusedId === null) return false;
		for (const id of aliveIds) {
			if (id === this.focusedId) return false;
		}
		this.focusedId = null;
		return true;
	}
}
