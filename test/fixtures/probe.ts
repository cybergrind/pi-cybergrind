import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only extension: prints the registered tool and command names once per
// session so headless smoke tests can assert deterministically what exists.
// Output format (stderr, one line):
//   [pi-probe] {"tools":["read","bash",...],"commands":["mcp",...]}

export const PROBE_PREFIX = "[pi-probe] ";

export interface ProbeReport {
	tools: string[];
	commands: string[];
}

export function parseProbe(stderr: string): ProbeReport | undefined {
	for (const line of stderr.split("\n")) {
		if (!line.startsWith(PROBE_PREFIX)) continue;
		try {
			return JSON.parse(line.slice(PROBE_PREFIX.length)) as ProbeReport;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export default function probe(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const tools = pi.getAllTools().map((t) => t.name).sort();
		const commands = pi.getCommands().map((c) => c.name).sort();
		process.stderr.write(`${PROBE_PREFIX}${JSON.stringify({ tools, commands })}\n`);
	});
}
