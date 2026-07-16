import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
	buildRpcArgs,
	serializeCommand,
	toAgentClientEvents,
} from "../extensions/lib/rpc-agent-client.ts";

describe("serializeCommand", () => {
	test("is one JSON object terminated by a newline", () => {
		const line = serializeCommand({ type: "prompt", message: "hi", id: "req_1" });
		assert.equal(line.endsWith("\n"), true);
		assert.deepEqual(JSON.parse(line), { type: "prompt", message: "hi", id: "req_1" });
	});
});

describe("buildRpcArgs", () => {
	test("appends --mode rpc after the resolved prefix args", () => {
		const args = buildRpcArgs(["/path/cli.js"], {});
		assert.deepEqual(args, ["/path/cli.js", "--mode", "rpc"]);
	});

	test("forwards an explicit model but omits it by default (inherit parent)", () => {
		assert.deepEqual(buildRpcArgs([], { model: "anthropic/claude" }), ["--mode", "rpc", "--model", "anthropic/claude"]);
		assert.deepEqual(buildRpcArgs([], {}), ["--mode", "rpc"]);
	});
});

describe("toAgentClientEvents", () => {
	test("agent_start / agent_end pass through", () => {
		assert.deepEqual(toAgentClientEvents({ type: "agent_start" }), [{ type: "agent_start" }]);
		assert.deepEqual(toAgentClientEvents({ type: "agent_end", messages: [] }), [{ type: "agent_end" }]);
	});

	test("tool_execution_start → tool_call (toolName)", () => {
		assert.deepEqual(toAgentClientEvents({ type: "tool_execution_start", toolName: "bash" }), [
			{ type: "tool_call", tool: "bash" },
		]);
	});

	test("tool_call_start → tool_call (legacy 'tool' field)", () => {
		assert.deepEqual(toAgentClientEvents({ type: "tool_call_start", tool: "read" }), [
			{ type: "tool_call", tool: "read" },
		]);
	});

	test("assistant message_end → assistant_text from text parts", () => {
		const evs = toAgentClientEvents({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
		});
		assert.deepEqual(evs, [{ type: "assistant_text", text: "hello world" }]);
	});

	test("assistant message_end with error stopReason emits an error event", () => {
		const evs = toAgentClientEvents({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "no key" },
		});
		assert.ok(evs.some((e) => e.type === "error" && /no key/.test(e.message)));
	});

	test("non-assistant messages and responses produce nothing", () => {
		assert.deepEqual(toAgentClientEvents({ type: "message_end", message: { role: "user", content: "hi" } }), []);
		assert.deepEqual(toAgentClientEvents({ type: "response", command: "prompt", success: true }), []);
		assert.deepEqual(toAgentClientEvents({ type: "turn_start" }), []);
	});

	test("ignores malformed input", () => {
		assert.deepEqual(toAgentClientEvents(null), []);
		assert.deepEqual(toAgentClientEvents("nope"), []);
		assert.deepEqual(toAgentClientEvents({}), []);
	});
});
