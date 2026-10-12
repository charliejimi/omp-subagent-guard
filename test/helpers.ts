import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SubagentGuardOptions } from "../src/index";
import { safeRemove, tempDir } from "./fixtures";

export const PACKAGE = path.resolve(import.meta.dir, "..");
export const SCOPED_TOOLS = ["read", "grep", "glob", "write", "edit", "yield", "hub"];

let entries = 0;

/** An extension entry that loads the guard with explicit options and no config file, and names its own path. */
export function writeGuardEntry(dir: string, options: SubagentGuardOptions = {}): string {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, `subagent-guard-${++entries}.ts`);
	const source = [
		`import { createSubagentGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "index.ts"))};`,
		`export default createSubagentGuard({ ...${JSON.stringify({ configPath: null, ...options }, null, "\t")}, entryPath: import.meta.path });`,
		"",
	].join("\n");
	fs.writeFileSync(entry, source);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

/** Forgets the guard's process-wide state, the way a new omp process starts without it. */
export function resetGuardState(): void {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-subagent-guard/registry/v1")];
}

export interface Asked {
	title: string;
	options: unknown[];
	timeout: number | undefined;
}

export interface FakeUI {
	asked: Asked[];
	notices: string[];
	widgets: Map<string, unknown>;
	ui: Record<string, unknown>;
}

/**
 * A UI that answers every selector with `answer`. With "none" it behaves like omp's RPC and TUI
 * selectors when nobody answers: it resolves `undefined` once the dialog's own timeout passes.
 */
export function fakeUI(answer: "Allow" | "Deny" | "none"): FakeUI {
	const asked: Asked[] = [];
	const notices: string[] = [];
	const widgets = new Map<string, unknown>();
	const ui = {
		notify: (message: string) => notices.push(message),
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		setStatus: () => {},
		select: async (title: string, options: unknown[], opts?: { timeout?: number; signal?: AbortSignal }) => {
			asked.push({ title, options, timeout: opts?.timeout });
			if (answer !== "none") return answer;
			if (opts?.timeout === undefined) return await new Promise<undefined>(() => {});
			await Bun.sleep(opts.timeout);
			return undefined;
		},
		confirm: async () => false,
		input: async () => undefined,
	};
	return { asked, notices, widgets, ui };
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface SessionOptions {
	entry: string;
	cwd: string;
	/** "sub" plants the `session_init` entry omp's task executor writes into every subagent session. */
	role?: "main" | "sub";
	/** The subagent's agent name and granted tools (`session_init.agent`, `session_init.tools`). */
	agent?: string;
	tools?: string[];
	/** For a subagent: its result id, so its session file is `<id>.jsonl` the way omp names it. */
	childId?: string;
	/** For a subagent: the main session's file, recorded as `parentSession`. */
	parentSessionFile?: string;
	/** The main session's UI; omitted or null means no UI (`hasUI: false`). */
	ui?: FakeUI | null;
	flags?: Record<string, string>;
	/** Persist the session to this directory so it has a session file. */
	sessionDir?: string;
	sessionManager?: SessionManager;
}

export interface Session {
	runner: ExtensionRunner;
	extensions: Extension[];
	sessionManager: SessionManager;
	toolCall(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<ToolCallResult | undefined>;
	toolResult(toolName: string, input: Record<string, unknown>, result?: { isError?: boolean; details?: unknown; text?: string; toolCallId?: string }): Promise<unknown>;
	beforeAgentStart(): Promise<unknown>;
	/** Calls every handler registered for `type` with the runner's own context and returns their results. */
	invoke(type: string, event: Record<string, unknown>): Promise<unknown[]>;
	command(name: string, args: string, ui: FakeUI): Promise<void>;
}

/** Loads a guard entry through omp's own loader and runner and starts the session in `cwd`. */
export async function loadSession(options: SessionOptions): Promise<Session> {
	const result = await discoverAndLoadExtensions([options.entry], options.cwd, undefined, undefined, { ambient: false });
	const extensions = result.extensions.filter(ext => ext.path === options.entry);
	const loadErrors = result.errors.filter(err => err.path === options.entry);
	if (loadErrors.length > 0 || extensions.length !== 1) {
		throw new Error(`guard did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	let sessionManager = options.sessionManager;
	if (!sessionManager) {
		if (options.role === "sub" && options.childId) {
			const dir = options.sessionDir ?? tempDir("sg-sessions-");
			sessionManager = await SessionManager.open(path.join(dir, `${options.childId}.jsonl`), undefined, undefined, {
				initialCwd: options.cwd,
				parentSession: options.parentSessionFile,
			});
		} else if (options.sessionDir) {
			sessionManager = SessionManager.create(options.cwd, options.sessionDir);
		} else {
			sessionManager = SessionManager.inMemory(options.cwd);
		}
	}
	if (options.role === "sub") {
		sessionManager.appendSessionInit({ systemPrompt: "", task: "assignment", tools: options.tools ?? SCOPED_TOOLS, agent: options.agent ?? "scoped-worker" });
	}
	const runner = new ExtensionRunner(extensions, result.runtime, options.cwd, sessionManager, await models());
	for (const [name, value] of Object.entries(options.flags ?? {})) runner.setFlagValue(name, value);
	const active = options.role === "sub" ? (options.tools ?? SCOPED_TOOLS) : ["read", "task"];
	runner.initialize(
		{ getActiveTools: () => active, getAllTools: () => [] } as never,
		{ getModel: () => undefined } as never,
		undefined,
		(options.ui?.ui ?? undefined) as never,
		options.role === "sub" ? "print" : "rpc",
	);
	await runner.emit({ type: "session_start" } as never);
	let calls = 0;
	return {
		runner,
		extensions,
		sessionManager,
		toolCall: (toolName, input, toolCallId) =>
			runner.emitToolCall({ type: "tool_call", toolCallId: toolCallId ?? `call-${++calls}`, toolName, input } as never) as Promise<ToolCallResult | undefined>,
		toolResult: (toolName, input, result = {}) =>
			runner.emitToolResult({
				type: "tool_result",
				toolCallId: result.toolCallId ?? `result-${++calls}`,
				toolName,
				input,
				content: [{ type: "text", text: result.text ?? "ok" }],
				isError: result.isError ?? false,
				details: result.details,
			} as never),
		beforeAgentStart: () => runner.emit({ type: "before_agent_start", prompt: "go", images: [] } as never),
		invoke: async (type, event) => {
			const ctx = runner.createContext();
			const results: unknown[] = [];
			for (const ext of extensions) {
				for (const handler of ext.handlers.get(type) ?? []) results.push(await (handler as (e: unknown, c: unknown) => unknown)({ type, ...event }, ctx));
			}
			return results;
		},
		command: async (name, args, ui) => {
			const command = runner.getCommand(name);
			if (!command) throw new Error(`/${name} is not registered`);
			// Spreading the context would evaluate its lazy getters (`model`), which these tests do not back.
			const ctx = Object.create(runner.createCommandContext()) as Record<string, unknown>;
			Object.defineProperties(ctx, { ui: { value: ui.ui }, hasUI: { value: true } });
			await command.handler(args, ctx as never);
		},
	};
}

/** Reads the guard's JSONL audit log. */
export function readAudit(file: string): Record<string, unknown>[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/** The single audit log the guard wrote into `dir`. */
export function auditFileIn(dir: string): string {
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith(".jsonl")) : [];
	if (files.length !== 1) throw new Error(`expected one audit log in ${dir}, found ${files.length}`);
	return path.join(dir, files[0]!);
}
