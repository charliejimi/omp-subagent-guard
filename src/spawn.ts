import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { realPathOf } from "./policy";

export interface SpawnItem {
	/** The agent the item names; `undefined` when it names none (omp would fall back to its default agent). */
	agent: string | undefined;
	isolated: boolean;
	/** Eval-defined tools the item hands to the subagent. */
	tools: string[];
}

function itemOf(raw: Record<string, unknown>, topIsolated: unknown): SpawnItem {
	const agent = typeof raw.agent === "string" && raw.agent.trim() !== "" ? raw.agent.trim() : undefined;
	const isolated = typeof raw.isolated === "boolean" ? raw.isolated : topIsolated === true;
	const tools = Array.isArray(raw.tools) ? raw.tools.map(tool => String(tool)) : [];
	return { agent, isolated, tools };
}

/** The spawns one `task` call asks for, read the way omp 18.2.8's task tool reads its two shapes. */
export function spawnItems(input: Record<string, unknown>): SpawnItem[] {
	if (Array.isArray(input.tasks) && input.tasks.length > 0) {
		return input.tasks.map(item => itemOf(item && typeof item === "object" ? (item as Record<string, unknown>) : {}, input.isolated));
	}
	return [itemOf(input, undefined)];
}

/**
 * Why `name` must not be spawned, or `undefined` when omp's own discovery from `cwd` resolves it to
 * the pinned file with a tool list inside `permittedTools` and no spawns. Inside omp, discovery sees
 * the session's extension roots; outside it, pass `roots` to stand in for them.
 */
export async function definitionProblem(
	name: string,
	pinned: string,
	cwd: string,
	permittedTools: readonly string[],
	roots?: EffectiveExtensionRoots,
): Promise<string | undefined> {
	const { agents } = await discoverAgents(cwd, os.homedir(), roots);
	const found = agents.find(agent => agent.name === name);
	if (!found) return `agent "${name}" has no definition`;
	const file = found.filePath ?? "";
	if (found.source === "bundled" || file.startsWith("embedded:")) return `the definition of "${name}" in use is omp's bundled one, not the pinned file`;
	if (realPathOf(path.resolve(file)) !== realPathOf(path.resolve(pinned))) {
		const where = found.source === "project" ? `the project (${path.relative(cwd, file) || file})` : `${found.source} level (${path.basename(file)})`;
		return `the definition of "${name}" in use comes from ${where}, not the pinned file`;
	}
	if (!found.tools) return `the definition of "${name}" has no tool list, so it would get every default tool`;
	const extra = found.tools.filter(tool => !permittedTools.includes(tool));
	if (extra.length > 0) return `the definition of "${name}" grants tools outside the subagent tool list: ${extra.map(tool => `"${tool}"`).join(", ")}`;
	if (found.spawns !== undefined && (found.spawns === "*" || found.spawns.length > 0)) return `the definition of "${name}" lets it spawn subagents`;
	return undefined;
}

function gitIgnored(file: string, cwd: string): boolean {
	const ran = Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", "--", file], { stdout: "ignore", stderr: "ignore" });
	return ran.exitCode === 0;
}

/**
 * Why an isolated subagent would run without this guard, or `undefined`. omp builds the copy from
 * the files git sees, so a guard file inside the project in a git-ignored place is missing there.
 */
export function isolationProblem(guardFiles: readonly string[], cwd: string): string | undefined {
	const root = realPathOf(path.resolve(cwd));
	for (const file of guardFiles) {
		const real = realPathOf(path.resolve(file));
		const rel = path.relative(root, real);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		if (gitIgnored(real, root)) return `the guard's file ${rel} is in a git-ignored part of the project, so an isolated copy would not contain it`;
	}
	return undefined;
}
