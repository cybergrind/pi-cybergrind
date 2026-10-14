import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkspace, waitForExit, workspaceBase, type Workspace } from "./lib/scroll-compose.ts";

const POPUP_H_RATIO = 0.2;
const MIN_POPUP_H = 5;
const MAX_POPUP_H = 8;

interface ClientInfo {
	height: number;
	width: number;
	statusLines: number;
	statusAtTop: boolean;
}

interface PopupGeom {
	x: number;
	y: number;
	w: number;
	h: number;
}

function renderInitLua(piPane: string, sentinel: string, tmpfile: string, pidfile: string): string {
	const q = (s: string) => JSON.stringify(s);
	return `
local pane = ${q(piPane)}
local sentinel = ${q(sentinel)}
local tmpfile = ${q(tmpfile)}
local pidfile = ${q(pidfile)}

-- Write nvim PID early so the extension can detect SIGKILL via process.kill(pid, 0).
pcall(function() vim.fn.writefile({tostring(vim.fn.getpid())}, pidfile) end)

local function scroll(direction)
  vim.fn.system({"tmux","send-keys","-t",pane,"-X",direction})
end

vim.keymap.set({"i","n"}, "<C-u>", function() scroll("halfpage-up")   end, {silent=true})
vim.keymap.set({"i","n"}, "<C-d>", function() scroll("halfpage-down") end, {silent=true})

local function save_and_quit()
  pcall(function() vim.cmd("silent! write!") end)
  vim.cmd("qa!")
end

local function apply_quit_binding()
  for _, lhs in ipairs({ "<C-[>", "<Esc>" }) do
    vim.keymap.set("n", lhs, save_and_quit,
      { silent = true, buffer = true, nowait = true, desc = "pi-scroll-compose: save+quit" })
  end
end

apply_quit_binding()
vim.api.nvim_create_autocmd({ "InsertLeave", "BufEnter" }, {
  buffer = 0,
  callback = apply_quit_binding,
})

vim.api.nvim_create_autocmd("VimLeavePre", {
  callback = function()
    pcall(function() vim.cmd("silent! write! " .. vim.fn.fnameescape(tmpfile)) end)
    vim.fn.system({"tmux","send-keys","-t",pane,"-X","cancel"})
    vim.fn.writefile({"done"}, sentinel)
  end,
})
`;
}

function parseClientInfo(out: string): ClientInfo {
	const parts = out.trim().split(/\s+/);
	const height = Math.max(10, Number.parseInt(parts[0] ?? "40", 10) || 40);
	const width = Math.max(20, Number.parseInt(parts[1] ?? "120", 10) || 120);
	const statusRaw = parts[2] ?? "1"; // "off", "on" (= 1), or "2"/"3"/"4"/"5"
	const statusLines = statusRaw === "off" || statusRaw === "0" ? 0 : Number.parseInt(statusRaw, 10) || 1;
	const statusAtTop = parts[3] === "top";
	return { height, width, statusLines, statusAtTop };
}

function computePopupGeometry(c: ClientInfo): PopupGeom {
	const usableHeight = c.height - c.statusLines;
	const h = Math.max(MIN_POPUP_H, Math.min(MAX_POPUP_H, Math.floor(usableHeight * POPUP_H_RATIO)));
	// tmux's -y for popups places the BOTTOM-LEFT corner. Anchor just above the status line.
	const y = c.statusAtTop ? c.height - 1 : c.height - c.statusLines - 1;
	return { x: 0, y, w: c.width, h };
}

function tmux(pi: ExtensionAPI) {
	return {
		enterCopyMode: (pane: string) => pi.exec("tmux", ["copy-mode", "-t", pane]),
		cancelCopyMode: (pane: string) => pi.exec("tmux", ["send-keys", "-t", pane, "-X", "cancel"]),
		queryClient: (pane: string) =>
			pi.exec("tmux", [
				"display-message",
				"-p",
				"-t",
				pane,
				"#{client_height} #{client_width} #{status} #{status_position}",
			]),
		displayPopup: (g: PopupGeom, cmd: string) =>
			pi.exec("tmux", [
				"display-popup",
				"-E",
				"-B",
				"-x", String(g.x),
				"-y", String(g.y),
				"-w", String(g.w),
				"-h", String(g.h),
				cmd,
			]),
	};
}

let busy = false;

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	pi.registerShortcut("ctrl+u", {
		description: "open nvim in tmux popup (pi pane → copy-mode); C-u/C-d scroll pi pane; sync on exit",
		handler: (ctx) => openScrollCompose(pi, ctx),
	});
}

async function openScrollCompose(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (busy) {
		ctx.ui.notify("scroll-compose: already open", "warning");
		return;
	}
	const piPane = process.env.TMUX_PANE;
	if (!piPane) {
		ctx.ui.notify("scroll-compose: not in tmux (TMUX_PANE unset)", "warning");
		return;
	}

	busy = true;
	const t = tmux(pi);
	let ws: Workspace | undefined;
	let preserveWorkspace = false;

	try {
		ws = createWorkspace(workspaceBase(process.env, getAgentDir()));
		writeFileSync(ws.initLua, renderInitLua(piPane, ws.sentinel, ws.tmpfile, ws.pidfile));
		writeFileSync(ws.tmpfile, ctx.ui.getEditorText() ?? "");

		await t.enterCopyMode(piPane);

		// Query client size + status line config so we can compute popup geometry
		// explicitly. tmux's `-y S` keyword and `-h "20%"` percentages behave
		// inconsistently across versions (and break entirely under nested tmux),
		// so we do the math here and pass absolute integers.
		const geom = computePopupGeometry(parseClientInfo((await t.queryClient(piPane)).stdout));

		// Single shell-command string so quoting is unambiguous. Workspace paths
		// (agent dir + mkdtemp suffix) are assumed shell-safe, so single-quote wrap is enough.
		// -c "luafile ..." (not -u) so the user's normal init.lua / init.vim loads first
		// and our bindings + VimLeavePre are layered on top.
		const launchCmd = `exec nvim -c 'luafile ${ws.initLua}' '${ws.tmpfile}'`;

		// display-popup is an overlay → pi's pane is not resized → pi's TUI does
		// not trigger a full redraw + scrollback clear. It blocks until the popup
		// closes and returns nvim's exit code, so the workspace files tell us how
		// nvim ended; the code is only reported.
		const popupRes = await t.displayPopup(geom, launchCmd);
		const exitKind = await waitForExit(ws.sentinel, ws.pidfile);

		if (exitKind === "clean") {
			const newText = readFileSync(ws.tmpfile, "utf8").replace(/\n$/, "");
			ctx.ui.setEditorText(newText);
			ctx.ui.setStatus("scroll-compose-redraw", undefined);
			return;
		}
		// VimLeavePre normally cancels copy-mode; it never ran here, so do it ourselves.
		await t.cancelCopyMode(piPane).catch(() => {});
		if (exitKind === "killed") {
			preserveWorkspace = true;
			ctx.ui.notify(`scroll-compose: nvim exited unexpectedly; draft kept at ${ws.tmpfile}`, "warning");
		} else {
			const popup = `display-popup code=${popupRes.code}${popupRes.stderr.trim() ? `: ${popupRes.stderr.trim()}` : ""}`;
			ctx.ui.notify(
				`scroll-compose: nvim never loaded ${ws.initLua} (${popup}); is ${dirname(ws.tmpfile)} visible to the tmux server?`,
				"error",
			);
		}
	} catch (err) {
		await t.cancelCopyMode(piPane).catch(() => {});
		ctx.ui.notify(`scroll-compose: ${(err as Error).message}`, "error");
	} finally {
		busy = false;
		if (!preserveWorkspace) ws?.cleanup();
	}
}
