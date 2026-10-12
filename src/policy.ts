import * as fs from "node:fs";
import * as path from "node:path";

export interface Places {
	/** The session's working directory: the project checkout, or an isolation copy. */
	cwd: string;
	home: string;
	/** Absolute places nobody in the session may write: `~/.omp`, the guard's own files, its audit log. */
	roots: string[];
	/** Extra globs, relative to `cwd`, that are protected too. */
	extra: string[];
}

function asStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

/** The paths a write, edit, or ast_edit call would write; `undefined` for other tools. */
export function writeTargets(toolName: string, input: Record<string, unknown>): string[] | undefined {
	switch (toolName) {
		case "write":
			return asStrings(input.path);
		case "edit": {
			const targets = asStrings(input.path);
			if (Array.isArray(input.edits)) {
				for (const edit of input.edits) {
					if (edit && typeof edit === "object") {
						for (const field of ["rename", "move", "moveTo", "to"]) targets.push(...asStrings((edit as Record<string, unknown>)[field]));
					}
				}
			}
			for (const text of [...asStrings(input.input), ...asStrings(input.patch)]) {
				for (const match of text.matchAll(PATCH_FILE_LINE)) targets.push(match[1]!);
			}
			return targets;
		}
		case "ast_edit":
			return asStrings(input.paths).flatMap(entry => entry.split(";").map(item => item.trim()).filter(Boolean));
		default:
			return undefined;
	}
}

const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isInternalUrl(target: string): boolean {
	return INTERNAL_URL.test(target);
}

function insideOrEqual(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The real path of `abs`, following symlinks through the deepest part of it that exists. */
export function realPathOf(abs: string): string {
	let existing = abs;
	const rest: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(existing), ...rest.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return abs;
			rest.push(path.basename(existing));
			existing = parent;
		}
	}
}

function expandHome(target: string, home: string): string {
	if (target === "~" || target === "$HOME" || target === "${HOME}") return home;
	for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
		if (target.startsWith(prefix)) return path.join(home, target.slice(prefix.length));
	}
	return target;
}

/** The lexical and the real absolute forms of a filesystem target. */
function forms(target: string, p: Places): string[] {
	const lexical = path.resolve(p.cwd, expandHome(target, p.home));
	const real = realPathOf(lexical);
	return real === lexical ? [lexical] : [lexical, real];
}

function protectedSegment(segment: string): boolean {
	return segment === ".git" || segment === ".omp" || segment === ".env" || segment === ".envrc" || segment.startsWith(".env.");
}

function protectedForm(abs: string, p: Places, cwds: string[]): boolean {
	for (const cwd of cwds) {
		if (!insideOrEqual(abs, cwd)) continue;
		const rel = path.relative(cwd, abs).split(path.sep).join("/");
		if (rel.split("/").some(protectedSegment)) return true;
		if (p.extra.some(glob => new Bun.Glob(glob).match(rel))) return true;
	}
	if (protectedSegment(path.basename(abs))) return true;
	const userOmp = path.join(p.home, ".omp");
	for (const root of p.roots) {
		for (const form of new Set([root, realPathOf(root)])) {
			if (!insideOrEqual(abs, form)) continue;
			// An isolated subagent works in a copy under ~/.omp/wt; its own files are not omp's.
			const exempt = (form === userOmp || form === realPathOf(userOmp)) && cwds.some(cwd => insideOrEqual(cwd, form) && insideOrEqual(abs, cwd));
			if (!exempt) return true;
		}
	}
	return false;
}

/** Whether writing `target` would touch a protected place. Internal URLs are not filesystem paths. */
export function isProtected(target: string, p: Places): boolean {
	if (isInternalUrl(target)) return false;
	const cwds = [...new Set([path.resolve(p.cwd), realPathOf(path.resolve(p.cwd))])];
	return forms(target, p).some(abs => protectedForm(abs, p, cwds));
}

/** Whether `target` is inside `cwd` (after following symlinks) and matches one of the scope globs. */
export function inScope(target: string, cwd: string, scope: readonly string[]): boolean {
	if (isInternalUrl(target) || scope.length === 0) return false;
	const root = realPathOf(path.resolve(cwd));
	const real = realPathOf(path.resolve(cwd, target));
	if (!insideOrEqual(real, root) || real === root) return false;
	const rel = path.relative(root, real).split(path.sep).join("/");
	return scope.some(glob => new Bun.Glob(glob).match(rel));
}

/** A target as shown in reasons and the audit log: relative to `cwd` when inside it. */
export function displayPath(target: string, cwd: string): string {
	if (isInternalUrl(target)) return target;
	const abs = path.resolve(cwd, target);
	return insideOrEqual(abs, path.resolve(cwd)) ? path.relative(path.resolve(cwd), abs) || "." : target;
}
