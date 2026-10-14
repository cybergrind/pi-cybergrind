import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Files shared between pi and the nvim that tmux-scroll-compose opens in a
// tmux popup, and the wait for that nvim to finish.
// Pure logic: no pi imports (unit tests run under node --experimental-strip-types).
//
// nvim is started by the tmux server, not by pi, so it sees the host
// filesystem. pi may not: under sbox (firejail --private-tmp) pi's /tmp is its
// own, so a workspace there is invisible to nvim. The workspace therefore lives
// in pi's agent dir, which the sandbox shares with the host.

/** Overrides the workspace base dir. */
export const ENV_DIR = "PI_SCROLL_COMPOSE_DIR";

/** How long nvim gets to write its pidfile before we give up on it. */
export const STARTUP_MS = 2000;
export const POLL_MS = 250;

export interface Workspace {
	tmpfile: string;
	sentinel: string;
	pidfile: string;
	initLua: string;
	cleanup: () => void;
}

/**
 * clean: nvim ran our VimLeavePre (draft saved).
 * killed: nvim started but died without it (e.g. SIGKILL).
 * lost: nvim never ran our init.lua (no pidfile), e.g. it could not see the workspace.
 */
export type ExitKind = "clean" | "killed" | "lost";

export function workspaceBase(env: NodeJS.ProcessEnv, agentDir: string): string {
	return env[ENV_DIR] || join(agentDir, "scroll-compose");
}

export function createWorkspace(base: string): Workspace {
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "pi-scroll-compose-"));
	return {
		tmpfile: join(dir, "input.txt"),
		sentinel: join(dir, "done"),
		pidfile: join(dir, "nvim.pid"),
		initLua: join(dir, "init.lua"),
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}

/**
 * Wait for nvim to finish. `tmux display-popup` blocks until the popup closes,
 * so this normally settles on the first check; the pid poll covers a popup
 * call that returned early.
 */
export async function waitForExit(
	sentinel: string,
	pidfile: string,
	opts: { startupMs?: number; pollMs?: number } = {},
): Promise<ExitKind> {
	const deadline = Date.now() + (opts.startupMs ?? STARTUP_MS);
	const pollMs = opts.pollMs ?? POLL_MS;
	while (true) {
		if (existsSync(sentinel)) return "clean";
		const pid = readPid(pidfile);
		if (pid === undefined) {
			if (Date.now() >= deadline) return "lost";
		} else if (!isProcessAlive(pid)) {
			// Final check: maybe sentinel was written between checks.
			return existsSync(sentinel) ? "clean" : "killed";
		}
		await sleep(pollMs);
	}
}

function readPid(pidfile: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
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
