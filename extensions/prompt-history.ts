import { join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHistory, compactHistory, ENV_FILE, loadHistory } from "./lib/prompt-history.ts";

// Prompt history across sessions.
//
// pi already browses submitted prompts with Up/Down, but keeps them in memory
// on the editor, so a new session starts empty. This installs pi's own editor
// class with two additions: it starts with the project's earlier prompts, and
// everything pi adds to the history is also appended to
// ~/.pi/agent/prompt-history.jsonl.
//
// History is per project (session cwd). Set PI_PROMPT_HISTORY=off to disable.

const OFF_VALUES = new Set(["off", "0", "false", "no"]);

export function historyFile(env: Record<string, string | undefined> = process.env): string {
	return env[ENV_FILE] || join(getAgentDir(), "prompt-history.jsonl");
}

export default function (pi: ExtensionAPI) {
	if (OFF_VALUES.has((process.env.PI_PROMPT_HISTORY ?? "").trim().toLowerCase())) return;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const file = historyFile();
		const cwd = ctx.cwd;
		let warned = false;
		const report = (what: string, err: unknown) => {
			if (warned) return;
			warned = true;
			ctx.ui.notify(`prompt-history: cannot ${what} ${file}: ${(err as Error).message}`, "warning");
		};

		class HistoryEditor extends CustomEditor {
			override addToHistory(text: string): void {
				super.addToHistory(text);
				try {
					appendHistory(file, cwd, text);
				} catch (err) {
					report("write", err);
				}
			}
			/** Fill the in-memory history without writing it back. */
			restore(prompts: string[]): void {
				for (const prompt of prompts) super.addToHistory(prompt);
			}
		}

		// Called only by the interactive TUI; a no-op in rpc and print modes.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// embedWorkingStatus matches pi's default editor.
			const editor = new HistoryEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			try {
				compactHistory(file);
				editor.restore(loadHistory(file, cwd));
			} catch (err) {
				report("read", err);
			}
			return editor;
		});
	});
}
