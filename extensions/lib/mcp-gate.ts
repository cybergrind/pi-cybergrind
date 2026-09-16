import { statSync } from "node:fs";
import { join } from "node:path";

// Decides whether the pi-mcp-adapter should be loaded for a session.
// Pure logic: no pi imports, no adapter imports (unit tests run under
// node --experimental-strip-types, which cannot digest the adapter's TS).

/** Project-level MCP config files, relative to the session cwd. */
export const PROJECT_CONFIG_FILES = [".mcp.json", ".pi/mcp.json"] as const;

/** Override: `off`/`0`/`false` never loads, `on`/`1`/`true` always loads. */
export const ENV_VAR = "PI_MCP";

export interface GateInput {
	cwd: string;
	env: Record<string, string | undefined>;
}

export interface GateDecision {
	load: boolean;
	/** Human-readable explanation, for debug logging. */
	reason: string;
	/** Project config files that exist (relative paths). */
	sources: string[];
	/** Set when the env override had an unrecognised value and was ignored. */
	warning?: string;
}

const ON_VALUES = new Set(["on", "1", "true", "yes"]);
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

function parseOverride(raw: string | undefined): { value?: "on" | "off"; warning?: string } {
	const v = raw?.trim().toLowerCase();
	if (!v) return {};
	if (ON_VALUES.has(v)) return { value: "on" };
	if (OFF_VALUES.has(v)) return { value: "off" };
	return { warning: `${ENV_VAR}=${JSON.stringify(raw)} is not one of on/off; ignoring it` };
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function findProjectConfigs(cwd: string): string[] {
	return PROJECT_CONFIG_FILES.filter((rel) => isFile(join(cwd, rel)));
}

export function shouldLoadMcp(input: GateInput): GateDecision {
	const sources = findProjectConfigs(input.cwd);
	const { value, warning } = parseOverride(input.env[ENV_VAR]);

	if (value === "off") {
		return { load: false, reason: `${ENV_VAR}=off`, sources };
	}
	if (value === "on") {
		return { load: true, reason: `${ENV_VAR}=on`, sources };
	}

	const base: Omit<GateDecision, "load" | "reason"> = warning ? { sources, warning } : { sources };
	if (sources.length > 0) {
		return { ...base, load: true, reason: `project config found: ${sources.join(", ")}` };
	}
	return {
		...base,
		load: false,
		reason: `no project MCP config (${PROJECT_CONFIG_FILES.join(" or ")}) in ${input.cwd}`,
	};
}
