// Test-only model provider for the live runs. It plays a script instead of calling a model, so real
// omp runs its real task tool, subagents, isolation, approvals, and extension hooks without a model.
//   SCRIPTED_PROVIDER_SCRIPT  JSON file: { "parent": Step[], "children": { "<marker>": Step[] } }
//                             A request whose first user message contains a child marker plays that
//                             child's steps; any other request plays "parent". Step N is the one after N
//                             assistant turns in the request, so the provider keeps no state: an isolated
//                             subagent loads a fresh copy of this module and still plays the right step.
//                             Once a script runs out it answers "done".
//   SCRIPTED_PROVIDER_LOG     JSONL file; each request's script, step, and messages are appended.
// omp resolves the @oh-my-pi imports to its own copies when it loads this file.
import * as fs from "node:fs";
import type { Api, AssistantMessage, Context, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface ScriptStep {
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	text?: string;
}

export interface Script {
	parent: ScriptStep[];
	children?: Record<string, ScriptStep[]>;
}

function loadScript(): Script {
	const file = process.env.SCRIPTED_PROVIDER_SCRIPT;
	if (!file) return { parent: [] };
	return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
}

function pick(script: Script, context: Context): { name: string; steps: ScriptStep[] } {
	const firstUser = context.messages.find(message => message.role === "user");
	const text = firstUser ? textOf(firstUser.content) : "";
	for (const [marker, steps] of Object.entries(script.children ?? {})) {
		if (text.includes(marker)) return { name: marker, steps };
	}
	return { name: "parent", steps: script.parent };
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function play(model: Model<Api>, context: Context) {
	const { name, steps } = pick(loadScript(), context);
	const index = context.messages.filter(message => message.role === "assistant").length;
	const step = steps[index] ?? { text: "done" };
	const log = process.env.SCRIPTED_PROVIDER_LOG;
	if (log) fs.appendFileSync(log, `${JSON.stringify({ script: name, step: index, messages: context.messages })}\n`);
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	if (step.toolCalls && step.toolCalls.length > 0) {
		for (const [n, call] of step.toolCalls.entries()) {
			const toolCall: ToolCall = { type: "toolCall", id: `scripted-${name}-${index}-${n}`, name: call.name, arguments: call.arguments };
			message.content.push(toolCall);
			const contentIndex = message.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial: message });
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
		}
		message.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message });
	} else {
		const text = step.text ?? "done";
		message.content.push({ type: "text", text });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	}
	return stream;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
	pi.registerProvider("scripted", {
		api: "scripted" as Api,
		baseUrl: "http://127.0.0.1:9",
		apiKey: "SCRIPTED_PROVIDER_KEY",
		streamSimple: play,
		models: [
			{
				id: "scripted",
				name: "Scripted test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
	});
}
