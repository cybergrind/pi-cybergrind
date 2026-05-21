import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	formatHeader,
	formatRecentEvents,
	formatTokens,
	isErrored,
	resolveOutput,
	runChildPi,
	trimOneLine,
} from "./lib/pi-runner.ts";
import { abortRun, type Run } from "./lib/run-registry.ts";

// `subagent` — dispatches a task to a nested `pi -p --mode json --no-session`
// child and surfaces the result back to the parent.
//
// Two surfaces, one runner (see ./lib/pi-runner.ts), one shared registry
// (see ./lib/run-registry.ts):
//   - Tool `subagent` (registerTool): orchestrator LLM calls this during a
//     turn; the final assistant text returns as the tool result.
//   - Slash `/subagent <task>`: user-initiated; final output is delivered
//     back via pi.sendUserMessage so it lands as the parent's next turn.
//
// Live state for the upcoming panel is read from run-registry; this file
// only registers the tool/command and formats output.
//
// Resolution: if `pi` is not on PATH (e.g. it's a shell alias), set PI_CMD
// to the binary or wrapper script — see resolvePiCommand() in the runner.

const WIDGET_KEY = "subagent";
const STATUS_KEY = "subagent";
const DEFAULT_MAX_DEPTH = 5;

function resolveMaxDepth(): number {
	const raw = process.env.PI_SUBAGENT_MAX_DEPTH;
	if (!raw) return DEFAULT_MAX_DEPTH;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DEPTH;
}

function currentDepth(): number {
	return Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
}

const subagentTool = defineTool({
	name: "subagent",
	label: "Subagent",
	description:
		"Dispatch a task to a nested `pi` session running in its own context. Returns the final assistant output so the orchestrator can read it and decide next steps. Use this for any unit of work that would pollute the orchestrator's context — multi-file reads, greps, builds, tests, plan drafting, code edits. Pass only `task` unless the user has explicitly told you to set other parameters.",
	parameters: Type.Object({
		task: Type.String({ description: "Self-contained brief for the subagent. Include goal, constraints, return-format expectations." }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process. DO NOT SET unless the user explicitly named a directory. Defaults to the parent's cwd." })),
		model: Type.Optional(Type.String({ description: "DO NOT SET unless the user explicitly named a model. Overriding silently routes the child to a different provider, which fails with 'No API key found' when that provider is not configured. The child inherits the parent's configured model by default — leave this unset." })),
		extraSystemPrompt: Type.Optional(
			Type.String({ description: "DO NOT SET unless the user explicitly asked for a specialized system prompt. The brief in `task` is the right place for per-call behavior. Setting this silently changes how the child interprets every turn." }),
		),
	}),
	async execute(_toolCallId, params, signal, onUpdate) {
		const depth = currentDepth();
		const max = resolveMaxDepth();
		if (depth >= max) {
			return {
				content: [{ type: "text", text: `subagent: max nesting depth ${max} reached` }],
				details: { error: "max_depth", depth },
			};
		}

		const parentRunId = process.env.PI_SUBAGENT_RUN_ID || undefined;

		const result = await runChildPi({
			task: params.task,
			parentDepth: depth,
			parentRunId,
			cwd: params.cwd,
			model: params.model,
			extraSystemPrompt: params.extraSystemPrompt,
			signal,
			onProgress: (run: Run) => {
				if (!onUpdate) return;
				const recent = formatRecentEvents(run, 8);
				const stats = `${run.usage.turns}t ↑${formatTokens(run.usage.input)} ↓${formatTokens(run.usage.output)} $${run.usage.cost.toFixed(4)}`;
				onUpdate({
					content: [{ type: "text", text: run.lastAssistantText || "(running…)" }],
					details: { runId: run.id, progress: [...recent, stats], usage: { ...run.usage } },
				});
			},
		});

		const header = formatHeader(result);
		const output = resolveOutput(result);
		return {
			content: [{ type: "text", text: `${header}\n\n${output}` }],
			details: {
				runId: result.runId,
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				usage: result.usage,
				took: result.took,
				piCommand: result.piCommand,
				errored: isErrored(result),
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(subagentTool);

	pi.registerCommand("subagent", {
		description: "Dispatch a task to a nested pi session; result delivered back as a user message",
		handler: async (rawArgs, ctx) => {
			const task = rawArgs.trim();
			if (!task) {
				ctx.ui.notify("/subagent: provide a task description", "warning");
				return;
			}

			const depth = currentDepth();
			const max = resolveMaxDepth();
			if (depth >= max) {
				ctx.ui.notify(`/subagent: max nesting depth ${max} reached`, "error");
				return;
			}

			const parentRunId = process.env.PI_SUBAGENT_RUN_ID || undefined;
			const taskHeader = trimOneLine(task, 60);

			const result = await runChildPi({
				task,
				parentDepth: depth,
				parentRunId,
				onProgress: (run: Run) => {
					const stats = `${run.usage.turns}t ↑${formatTokens(run.usage.input)} ↓${formatTokens(run.usage.output)} $${run.usage.cost.toFixed(4)}`;
					ctx.ui.setWidget(WIDGET_KEY, [
						`⏳ subagent[d${depth + 1}] ${run.id.slice(0, 8)}: ${taskHeader}`,
						...formatRecentEvents(run, 8),
						stats,
					]);
					ctx.ui.setStatus(STATUS_KEY, `subagent ${stats}`);
				},
			});

			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);

			const header = formatHeader(result);
			const output = resolveOutput(result);
			const taskQuote = task.length > 200 ? `${task.slice(0, 200)}…` : task;
			const body = `${header}\nTask: ${taskQuote}\nRun: ${result.runId}\nVia: ${result.piCommand}\n\n---\n\n${output}`;

			const deliverOptions = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
			pi.sendUserMessage(body, deliverOptions);

			ctx.ui.notify(
				isErrored(result) ? `subagent failed (exit ${result.exitCode})` : `subagent done in ${result.took.toFixed(1)}s`,
				isErrored(result) ? "error" : "info",
			);
		},
	});

	pi.registerCommand("subagent-abort", {
		description: "Abort a running subagent by run-id prefix",
		handler: async (rawArgs, ctx) => {
			const prefix = rawArgs.trim();
			if (!prefix) {
				ctx.ui.notify("/subagent-abort: pass a run-id prefix (first 8 chars suffice)", "warning");
				return;
			}
			// Lazy import to keep the dependency graph in subagent.ts thin.
			const { listRuns } = await import("./lib/run-registry.ts");
			const matches = listRuns({ status: ["starting", "running"] }).filter((r) => r.id.startsWith(prefix));
			if (matches.length === 0) {
				ctx.ui.notify(`no running subagent matches "${prefix}"`, "warning");
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify(`/subagent-abort: ${matches.length} matches, narrow the prefix`, "warning");
				return;
			}
			const ok = abortRun(matches[0].id);
			ctx.ui.notify(
				ok ? `aborted ${matches[0].id.slice(0, 8)}` : `could not abort ${matches[0].id.slice(0, 8)}`,
				ok ? "info" : "error",
			);
		},
	});
}
