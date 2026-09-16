import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ENV_VAR, PROJECT_CONFIG_FILES, shouldLoadMcp, type GateDecision, type GateInput } from "./lib/mcp-gate.ts";

// Gated MCP support via pi-mcp-adapter.
//
// The adapter is loaded only when the session's project configures MCP
// (`.mcp.json` or `.pi/mcp.json` in cwd) or `PI_MCP=on` is set. Without a
// project config nothing from the adapter is imported or registered: no `mcp`
// proxy tool, no adapter commands, zero context cost. `PI_MCP=off` disables it
// unconditionally.
//
// Gated-off sessions still get a tiny `/mcp` stub so the adapter can be pulled
// in on demand (`/mcp load`) or its setup flow reached directly (`/mcp setup`)
// for initial configuration. The stub loads the adapter into the running
// session; the adapter's own `/mcp` registration then replaces the stub
// (pi's registerCommand is a Map.set on the extension's command table, so a
// later registration with the same name wins and the change is visible to the
// next dispatch, which resolves commands fresh each time).
//
// The adapter keeps its normal file-layered config mode; adapter settings
// belong in `~/.pi/agent/mcp.json` or the project file, not here.
//
// The adapter resolves the project with `process.cwd()` at load time, so the
// gate uses the same value. `/reload` re-runs this factory, which re-evaluates
// the gate when a config file is added mid-session.

export type McpInstaller = (pi: ExtensionAPI) => Promise<void> | void;

/** Name of the slash command shared by the stub and the adapter. */
export const MCP_COMMAND = "mcp";

/** What the stub captures from the adapter's own `/mcp` registration. */
export type McpCommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];

const ADAPTER_MODULE = "pi-mcp-adapter";

/**
 * Dynamically import the adapter so gated-off sessions never evaluate its
 * module graph. The specifier is a variable on purpose: a literal would make
 * tsc type-check the adapter's shipped `.ts` sources (skipLibCheck only
 * covers `.d.ts`), which fail under our strict settings.
 */
export const defaultInstaller: McpInstaller = async (pi) => {
	const mod = (await import(ADAPTER_MODULE)) as { default: (pi: ExtensionAPI) => void };
	mod.default(pi);
};

function debugLog(line: string): void {
	if (process.env.PI_MCP_DEBUG) process.stderr.write(`[mcp] ${line}\n`);
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else process.stderr.write(`[mcp] ${message}\n`);
}

/**
 * Install the adapter through a proxy of `pi` that observes registerCommand,
 * so the stub can forward its own invocation to the adapter's `/mcp` handler.
 * Everything else passes straight through to the real `pi`.
 */
export async function installCapturingMcpCommand(
	pi: ExtensionAPI,
	installer: McpInstaller,
): Promise<McpCommandSpec | undefined> {
	let captured: McpCommandSpec | undefined;
	const proxy = new Proxy(pi, {
		get(target, prop) {
			if (prop === "registerCommand") {
				return (name: string, options: McpCommandSpec) => {
					if (name === MCP_COMMAND) captured = options;
					target.registerCommand(name, options);
				};
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
		},
	});
	await installer(proxy);
	return captured;
}

export function stubNotice(decision: GateDecision, cwd: string): string {
	const why =
		decision.reason === `${ENV_VAR}=off`
			? `${ENV_VAR}=off is set in the environment`
			: `no ${PROJECT_CONFIG_FILES.join(" or ")} in ${cwd}`;
	return (
		`MCP is off for this session: ${why}. ` +
		`${ENV_VAR}=on forces it on. ` +
		`/mcp setup configures servers (loads pi-mcp-adapter for this session); /mcp load loads it with the current config.`
	);
}

const STUB_SUBCOMMANDS = [
	{ value: "setup", label: "setup — Configure MCP servers (loads the adapter)" },
	{ value: "load", label: "load — Load pi-mcp-adapter for this session" },
	{ value: "status", label: "status — Why MCP is off" },
];

/**
 * Register the gated-off `/mcp` stub. Loading is memoised so repeated
 * `/mcp load` (or a `load` racing a `setup`) installs the adapter once.
 */
export function registerMcpStub(
	pi: ExtensionAPI,
	decision: GateDecision,
	cwd: string,
	installer: McpInstaller,
): void {
	let loading: Promise<McpCommandSpec | undefined> | undefined;
	const load = () => (loading ??= installCapturingMcpCommand(pi, installer));

	pi.registerCommand(MCP_COMMAND, {
		description: "MCP is off for this project — `/mcp setup` or `/mcp load` enables it for this session",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			if (/\s/.test(p)) return null;
			const items = STUB_SUBCOMMANDS.filter(({ value }) => value.startsWith(p));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "" || sub === "status") {
				notify(ctx, stubNotice(decision, cwd));
				return;
			}
			const adapterCommand = await load();
			debugLog(`loaded pi-mcp-adapter on demand via /mcp ${sub}`);
			if (sub === "load") {
				notify(ctx, "pi-mcp-adapter loaded for this session; /mcp now shows the adapter panel.");
				return;
			}
			if (!adapterCommand) {
				notify(ctx, "pi-mcp-adapter loaded but did not register /mcp; run /reload.", "error");
				return;
			}
			await adapterCommand.handler(args, ctx);
		},
	});
}

export function createGatedMcpExtension(
	installer: McpInstaller = defaultInstaller,
	deps?: Partial<GateInput>,
): (pi: ExtensionAPI) => Promise<void> {
	return async (pi) => {
		const cwd = deps?.cwd ?? process.cwd();
		const decision = shouldLoadMcp({ cwd, env: deps?.env ?? process.env });
		if (decision.warning) process.stderr.write(`[mcp] ${decision.warning} (${ENV_VAR})\n`);
		debugLog(`${decision.load ? "loading" : "skipping"} pi-mcp-adapter: ${decision.reason}`);
		if (!decision.load) {
			registerMcpStub(pi, decision, cwd, installer);
			return;
		}
		await installer(pi);
	};
}

export default createGatedMcpExtension();
