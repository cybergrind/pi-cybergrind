#!/usr/bin/env node
// Test-only MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
// Exposes one tool, `smoke_marker_get`, which returns a fixed marker string so
// a smoke test can prove a call went through a real MCP client end to end.

import { createInterface } from "node:readline";

const TOOL = "smoke_marker_get";
const MARKER = "MCP-STUB-MARKER-7f3a";

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(req) {
	const { id, method, params } = req;
	if (id === undefined) return; // notification
	switch (method) {
		case "initialize":
			return send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "pi-cybergrind-stub", version: "0" },
				},
			});
		case "ping":
			return send({ jsonrpc: "2.0", id, result: {} });
		case "tools/list":
			return send({
				jsonrpc: "2.0",
				id,
				result: {
					tools: [
						{
							name: TOOL,
							description: "Return the smoke marker string. Takes no arguments.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				},
			});
		case "tools/call":
			if (params?.name !== TOOL) {
				return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
			}
			return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: MARKER }], isError: false } });
		default:
			return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	try {
		handle(JSON.parse(line));
	} catch {
		/* ignore malformed input */
	}
});
