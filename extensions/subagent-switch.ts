import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	closeAgent,
	getAgent,
	interruptAgent,
	listAgents,
	poolEvents,
	sendToAgent,
	setDefaultClientFactory,
	spawnAgent,
} from "./lib/agent-pool.ts";
import { createRpcAgentClient } from "./lib/rpc-agent-client.ts";
import { FocusRouter } from "./lib/focus-router.ts";
import { buildSwitcherItems, formatFocusWidget, shouldActivate, TOP_LEVEL } from "./lib/switcher.ts";
import { SwitcherList } from "./lib/switcher-list.ts";

// The subagent switcher: a focus layer over the interactive-agent pool.
//
//   - Alt+S / `/subagent-switch` opens a floating overlay (middle-right) listing
//     the top-level session plus every interactive subagent.
//   - Picking an agent "focuses" it: your typed input is then delivered into that
//     subagent's loop (prompt when idle, follow-up when busy) instead of the
//     top-level agent. Slash commands always still reach the top level.
//   - Esc (or Ctrl+[) interrupts a busy focused agent, or — when it is idle —
//     drops focus back to the top level.
//
// Spawn interactive subagents with `/subagent-interactive <task>`. One-shot
// dispatches still go through ./subagent.ts; this file never touches those.

type Ui = ExtensionContext["ui"];

const WIDGET_KEY = "subagent-focus";
const router = new FocusRouter();

let lastUi: Ui | undefined;
let rawInputWired = false;
let overlayOpen = false;

// ──────────────────────────────── wiring ────────────────────────────────────

function focusWidget(ui: Ui): void {
	const id = router.current();
	const agent = id ? getAgent(id) ?? null : null;
	ui.setWidget(WIDGET_KEY, formatFocusWidget(agent));
}

function handleRawInput(data: string): { consume?: boolean } | undefined {
	// While the overlay owns the keyboard, let it handle its own keys.
	if (overlayOpen || !router.isFocused()) return undefined;
	if (data !== "\x1b") return undefined; // only a lone Esc / Ctrl+[

	const id = router.current();
	if (!id) return undefined;
	const agent = getAgent(id);
	if (agent && agent.status === "busy") {
		interruptAgent(id);
		lastUi?.notify(`interrupted ${agent.name}`, "info");
	} else {
		router.focus(null);
		if (lastUi) focusWidget(lastUi);
		lastUi?.notify("left subagent — back to top-level", "info");
	}
	return { consume: true };
}

function ensureWiring(ui: Ui): void {
	lastUi = ui;
	if (rawInputWired) return;
	rawInputWired = true;
	ui.onTerminalInput(handleRawInput);
}

async function openSwitcher(ctx: ExtensionContext): Promise<void> {
	ensureWiring(ctx.ui);
	if (listAgents().length === 0) {
		ctx.ui.notify("no interactive subagents — start one with /subagent-interactive <task>", "info");
		return;
	}

	overlayOpen = true;
	let unsubscribePool: (() => void) | undefined;
	let choice: string | undefined;
	try {
		choice = await ctx.ui.custom<string | undefined>(
			(tui, _theme, _kb, done) => {
				const list = new SwitcherList(
					() => buildSwitcherItems(listAgents(), router.current()),
					done,
					(id) => {
						const name = getAgent(id)?.name ?? id.slice(0, 8);
						void closeAgent(id);
						ctx.ui.notify(`closed subagent "${name}"`, "info");
					},
					() => tui.requestRender(),
				);
				// Live-refresh: when the pool changes (an agent is closed, a status
				// flips, a new one spawns), redraw so the overlay reflects it.
				const onChange = () => tui.requestRender();
				poolEvents.on("pool:update", onChange);
				poolEvents.on("pool:remove", onChange);
				poolEvents.on("pool:add", onChange);
				unsubscribePool = () => {
					poolEvents.off("pool:update", onChange);
					poolEvents.off("pool:remove", onChange);
					poolEvents.off("pool:add", onChange);
				};
				return list;
			},
			{ overlay: true, overlayOptions: { anchor: "right-center", width: "45%", maxHeight: "70%", margin: 1 } },
		);
	} finally {
		overlayOpen = false;
		unsubscribePool?.();
	}

	if (choice === undefined) return; // cancelled
	if (choice === TOP_LEVEL) {
		router.focus(null);
		ctx.ui.notify("focus: top-level (you)", "info");
	} else {
		router.focus(choice);
		ctx.ui.notify(`focus: ${getAgent(choice)?.name ?? choice} — type to send`, "info");
	}
	focusWidget(ctx.ui);
}

function onPoolChange(): void {
	const activeIds = listAgents({ active: true }).map((a) => a.id);
	const cleared = router.reconcile(activeIds);
	if (!lastUi) return;
	if (cleared) lastUi.notify("focused subagent stopped — back to top-level", "warning");
	focusWidget(lastUi);
}

export default function (pi: ExtensionAPI) {
	if (!shouldActivate(process.env)) return;

	setDefaultClientFactory(createRpcAgentClient);
	poolEvents.on("pool:update", onPoolChange);
	poolEvents.on("pool:remove", onPoolChange);

	// Redirect typed input to the focused subagent. Slash commands and
	// non-interactive (programmatic) input always pass through to the top level.
	pi.on("input", (ev, ctx) => {
		ensureWiring(ctx.ui);
		if (ev.source !== "interactive" || !router.isFocused()) return;
		const text = ev.text ?? "";
		if (text.startsWith("/")) return; // top-level slash commands still work
		if (!text.trim()) return { action: "handled" } as const; // swallow empty submits

		const id = router.current();
		if (!id) return;
		const mode = sendToAgent(id, text);
		if (!mode) {
			router.focus(null);
			focusWidget(ctx.ui);
			ctx.ui.notify("focused subagent is gone — focus cleared; resend your message", "warning");
			return { action: "handled" } as const;
		}
		focusWidget(ctx.ui);
		ctx.ui.notify(`→ ${getAgent(id)?.name ?? "subagent"} (${mode})`, "info");
		return { action: "handled" } as const;
	});

	pi.registerShortcut("alt+s", {
		description: "Open the subagent switcher (focus an interactive subagent)",
		handler: (ctx) => openSwitcher(ctx),
	});

	pi.registerCommand("subagent-switch", {
		description: "Open the subagent switcher overlay (middle-right)",
		handler: (_rawArgs, ctx) => openSwitcher(ctx),
	});

	pi.registerCommand("subagent-interactive", {
		description: "Spawn an interactive subagent you can switch to and chat with",
		handler: async (rawArgs, ctx) => {
			ensureWiring(ctx.ui);
			const task = rawArgs.trim();
			if (!task) {
				ctx.ui.notify("/subagent-interactive: provide a task description", "warning");
				return;
			}
			try {
				const agent = await spawnAgent({ task });
				ctx.ui.notify(`subagent "${agent.name}" started — Alt+S to switch`, "info");
			} catch (err) {
				ctx.ui.notify(`subagent spawn failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
