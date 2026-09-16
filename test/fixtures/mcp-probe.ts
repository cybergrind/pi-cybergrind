import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only extension: prints the registered tool and command names once per
// session so headless smoke tests can assert deterministically what exists.
// Output format (stderr, one line):
//   [mcp-probe] {"tools":["read","bash",...],"commands":["mcp",...]}

export const PROBE_PREFIX = "[mcp-probe] ";

export default function mcpProbe(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const tools = pi.getAllTools().map((t) => t.name).sort();
		const commands = pi.getCommands().map((c) => c.name).sort();
		process.stderr.write(`${PROBE_PREFIX}${JSON.stringify({ tools, commands })}\n`);
	});
}
