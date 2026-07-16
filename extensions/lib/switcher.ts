import type { AgentStatus, InteractiveAgent } from "./agent-pool.ts";

// Pure presentation + activation helpers for the subagent switcher. Kept free
// of pi-tui and process I/O so they unit-test cleanly; the overlay component
// and event wiring live in ../subagent-switch.ts.

/** Sentinel value for the "return to the top-level agent" switcher entry. */
export const TOP_LEVEL = "__top__";

export interface SwitcherItem {
	value: string; // agent id, or TOP_LEVEL
	label: string;
	detail: string;
	focused: boolean;
}

/**
 * Whether the switcher should wire itself up. It must stay dormant inside a
 * nested subagent — those children load the same extensions, and a switcher
 * within a switchable agent would route input into itself.
 */
export function shouldActivate(env: NodeJS.ProcessEnv): boolean {
	if (env.PI_INTERACTIVE_SUBAGENT) return false;
	const depth = Number.parseInt(env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	return depth <= 0;
}

export function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "starting":
			return "◌";
		case "idle":
			return "○";
		case "busy":
			return "●";
		case "stopped":
			return "■";
		case "error":
			return "✗";
	}
}

function snippet(agent: InteractiveAgent): string {
	const base = agent.lastTool ? `[${agent.lastTool}] ${agent.lastText}` : agent.lastText;
	const flat = base.replace(/\s+/g, " ").trim();
	if (!flat) return agent.status === "starting" ? "(starting…)" : "";
	return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** Rows for the switcher overlay: a top-level entry followed by each agent. */
export function buildSwitcherItems(agents: InteractiveAgent[], focusedId: string | null): SwitcherItem[] {
	const items: SwitcherItem[] = [
		{
			value: TOP_LEVEL,
			label: "⌂ top-level (you)",
			detail: "your main pi session",
			focused: focusedId === null,
		},
	];
	for (const a of agents) {
		items.push({
			value: a.id,
			label: `${statusGlyph(a.status)} ${a.name} · ${a.status}`,
			detail: snippet(a),
			focused: a.id === focusedId,
		});
	}
	return items;
}

/** Widget lines for the editor while focused on an agent; undefined at top-level. */
export function formatFocusWidget(agent: InteractiveAgent | null): string[] | undefined {
	if (!agent) return undefined;
	const leave = agent.status === "busy" ? "Esc to interrupt" : "Esc to leave (back to top-level)";
	return [`▶ subagent: ${agent.name} (${agent.status}) — type to send · ${leave} · Alt+S to switch`];
}
