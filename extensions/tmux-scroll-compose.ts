import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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
	const workdir = mkdtempSync(join(tmpdir(), "pi-scroll-compose-"));
	const tmpfile = join(workdir, "input.txt");
	const sentinel = join(workdir, "done");
	const pidfile = join(workdir, "nvim.pid");
	const initLua = join(workdir, "init.lua");

	try {
		writeFileSync(initLua, renderInitLua(piPane, sentinel, tmpfile, pidfile));
		writeFileSync(tmpfile, ctx.ui.getEditorText() ?? "");

		await pi.exec("tmux", ["copy-mode", "-t", piPane]);

		// Single shell-command string so quoting is unambiguous. mkdtempSync paths are
		// shell-safe (no quotes/metachars) so single-quote wrap is enough.
		// -c "luafile ..." (not -u) so the user's normal init.lua / init.vim loads first
		// and our bindings + VimLeavePre are layered on top.
		const launchCmd = `exec nvim -c 'luafile ${initLua}' '${tmpfile}'`;

		// Query client size + status line config so we can compute popup geometry
		// explicitly. tmux's `-y S` keyword and `-h "20%"` percentages behave
		// inconsistently across versions (and break entirely under nested tmux),
		// so we do the math here and pass absolute integers.
		const cfgRes = await pi.exec("tmux", [
			"display-message",
			"-p",
			"-t",
			piPane,
			"#{client_height} #{client_width} #{status} #{status_position}",
		]);
		const parts = cfgRes.stdout.trim().split(/\s+/);
		const clientHeight = Math.max(10, Number.parseInt(parts[0] ?? "40", 10) || 40);
		const clientWidth = Math.max(20, Number.parseInt(parts[1] ?? "120", 10) || 120);
		const statusRaw = parts[2] ?? "1"; // "off", "on" (= 1), or "2"/"3"/"4"/"5"
		const statusLines = statusRaw === "off" || statusRaw === "0" ? 0 : Number.parseInt(statusRaw, 10) || 1;
		const statusAtTop = parts[3] === "top";

		// Cap height: prefer the smaller of 8 rows or 20% of available area.
		const usableHeight = clientHeight - statusLines;
		const popupHeight = Math.max(5, Math.min(8, Math.floor(usableHeight * 0.2)));

		// tmux's -y for popups places the BOTTOM-LEFT corner. So to anchor the popup
		// to the bottom of the usable area (just above the status line), we want
		// the bottom-left at the last usable row.
		const popupY = statusAtTop ? clientHeight - 1 : clientHeight - statusLines - 1;

		// display-popup is an overlay → pi's pane is not resized → pi's TUI does
		// not trigger a full redraw + scrollback clear.
		// -E: auto-close popup when nvim exits. -B: no border.
		// display-popup returns immediately; close detection is via sentinel + PID poll.
		const popupRes = await pi.exec("tmux", [
			"display-popup",
			"-E",
			"-B",
			"-x", "0",
			"-y", String(popupY),
			"-w", String(clientWidth),
			"-h", String(popupHeight),
			launchCmd,
		]);
		if (popupRes.code !== 0) {
			throw new Error(`tmux display-popup failed: code=${popupRes.code} stderr=${popupRes.stderr.trim()}`);
		}

		const exitKind = await waitForExit(sentinel, pidfile);

		if (exitKind === "clean") {
			const newText = readFileSync(tmpfile, "utf8").replace(/\n$/, "");
			ctx.ui.setEditorText(newText);
			ctx.ui.setStatus("scroll-compose-redraw", undefined);
		} else {
			// Belt-and-braces: VimLeavePre normally cancels copy-mode, but on SIGKILL
			// it never ran, so do it ourselves.
			await pi.exec("tmux", ["send-keys", "-t", piPane, "-X", "cancel"]).catch(() => {});
			ctx.ui.notify(`scroll-compose: nvim exited unexpectedly; draft kept at ${tmpfile}`, "warning");
			return; // skip cleanup so user can recover draft
		}
	} catch (err) {
		ctx.ui.notify(`scroll-compose: ${(err as Error).message}`, "error");
	} finally {
		busy = false;
		try {
			rmSync(workdir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

async function waitForExit(sentinel: string, pidfile: string): Promise<"clean" | "killed"> {
	// Brief grace period so we don't race nvim writing the pidfile at startup.
	await sleep(500);
	while (true) {
		if (existsSync(sentinel)) return "clean";
		if (existsSync(pidfile)) {
			const pidStr = readFileSync(pidfile, "utf8").trim();
			const pid = Number.parseInt(pidStr, 10);
			if (Number.isFinite(pid) && !isProcessAlive(pid)) {
				// Final check: maybe sentinel was written between checks.
				if (existsSync(sentinel)) return "clean";
				return "killed";
			}
		}
		await sleep(250);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
