/**
 * Read-before-edit guard for omp 18.4.4 and 18.6.1.
 *
 * omp already rejects hashline edits anchored on lines the model never saw
 * (edit.enforceSeenLines, on by default), so hashline edits pass through
 * here untouched. This guard covers what that setting does not:
 *
 * - a replace-mode edit (old_string/new_string) to a file the model has not
 *   seen in this session;
 * - a write that overwrites an existing file the model has not seen, or that
 *   changed on disk after the model last saw it.
 *
 * A file counts as seen when a tool result displayed it (omp heads displayed
 * content with "[path#TAG]"), when a read of it succeeded, when the model's
 * own edit or write to it succeeded, or when a successful bash command named
 * it after a viewing command (cat, head, tail, sed -n, grep, rg, nl, less).
 *
 * The same refused call is let through on its third attempt, so the guard
 * can never hold the goal in a loop.
 *
 * OMP_STRATA_READ_GUARD: unset or "log" logs what it would refuse and changes
 * nothing; "on" refuses; "off" disables it. Turn it on only after an A/B on
 * the bench shows it helps.
 */
import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";

const MODE = (process.env.OMP_STRATA_READ_GUARD ?? "log").toLowerCase();
/** Attempts of one refused call before it is let through. */
const LET_THROUGH_AFTER = 2;
const MARKER = `<system-interrupt reason="read_before_edit">`;
const HEADER_RE = /^\[([^\]#\n]+)#[0-9A-Fa-f]{3,8}\]/gm;
const VIEW_RE = /(?:^|[;&|(]\s*|\s)(?:cat|head|tail|less|more|nl|bat|grep|rg|ag|sed\s+-n|awk)\b/;

interface ToolEvent {
	toolName: string;
	input: unknown;
	toolCallId?: string;
}

interface ToolResult extends ToolEvent {
	isError: boolean;
	content?: Array<{ type?: string; text?: string }>;
}

interface Ctx {
	cwd?: string;
	sessionManager?: { getCwd?: () => string; getBranch?: () => readonly SessionEntry[] };
}

interface SessionEntry {
	message?: { role?: string; content?: unknown; isError?: boolean; toolCallId?: string; toolName?: string };
}

/** Seen files: absolute path -> mtime (ms) when last seen, or -1 when unknown. */
export type SeenMap = Map<string, number>;

function cwdOf(ctx: Ctx | undefined): string {
	try {
		return ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
	} catch {
		return process.cwd();
	}
}

/** Strip a read's line range (path:10-40, path:10), its ?q= question and its :img suffix. */
export function cleanPath(raw: string): string {
	return raw.trim().replace(/\?.*$/, "").replace(/:img$/i, "").replace(/:\d+(?:-\d+)?$/, "");
}

function resolve(cwd: string, raw: string): string {
	return nodePath.resolve(cwd, cleanPath(raw));
}

function mtime(abs: string): number | undefined {
	try {
		return fs.statSync(abs).mtimeMs;
	} catch {
		return undefined;
	}
}

function text(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map(block => String((block as { text?: unknown }).text ?? ""))
		.join("\n");
}

function field(input: unknown, key: string): unknown {
	return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function pathOf(input: unknown): string | undefined {
	for (const key of ["path", "file_path", "file"]) {
		const value = field(input, key);
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/** Path-like words of a bash command that views files. */
export function viewedByBash(command: string): string[] {
	if (!VIEW_RE.test(command)) return [];
	// Quoted words first, so "my file.txt" stays one path. recordResult keeps only words that exist as files.
	const words: string[] = [];
	for (const match of command.matchAll(/"([^"]+)"|'([^']+)'|([^\s'"`;&|<>()]+)/g)) words.push(match[1] ?? match[2] ?? match[3]);
	return words.filter(word => !word.startsWith("-") && !/^\d+(?:,\d+)?p?$/.test(word));
}

/**
 * Absolute paths a bash command views, following `cd` the way the shell would: `cd cinderline && cat tools/x.mjs`
 * views cinderline/tools/x.mjs. Segments are split on &&, ||, ; and newlines; a pipe stays in its segment.
 */
export function viewedPaths(command: string, base: string): string[] {
	const out: string[] = [];
	let dir = base;
	let previous = base;
	const home = process.env.HOME || os.homedir();
	// Split on unescaped &&, ||, ; and newlines. A cd inside a pipeline runs in a subshell and moves nothing,
	// so a segment with a pipe is read as viewing commands from the current directory.
	for (const segment of command.split(/\s*(?<!\\)(?:&&|\|\||;|\n)\s*/)) {
		const cd = /(?<!\\)\|/.test(segment) ? null : /^cd(?:\s+(.*))?$/.exec(segment.trim());
		if (cd) {
			// Words: quoted, backslash-escaped spaces, or plain; flags (-L, -P, -e, -@) and "--" are skipped.
			const args = [...(cd[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g)]
				.map(m => m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, "$1"));
			let i = 0;
			while (i < args.length && /^-[LPe@]+$/.test(args[i])) i++;
			if (args[i] === "--") i++;
			const target = args[i];
			const next = target === undefined ? home
				: target === "-" ? previous
				: nodePath.resolve(dir, target.replace(/^~(?=\/|$)/, home));
			previous = dir;
			dir = next;
			continue;
		}
		// In a pipeline, a cd stage changes nothing and its argument is not a viewed file: skip it.
		for (const stage of segment.split(/(?<!\\)\|/)) {
			if (/^\s*cd(?:\s|$)/.test(stage)) continue;
			for (const word of viewedByBash(stage)) out.push(nodePath.resolve(dir, cleanPath(word)));
		}
	}
	return out;
}

/** Record every file a successful tool result shows the model. */
export function recordResult(seen: SeenMap, cwd: string, result: ToolResult): void {
	if (result.isError) return;
	const body = text(result.content);
	if (body.includes(MARKER)) return;
	const mark = (raw: string): void => {
		const abs = resolve(cwd, raw);
		seen.set(abs, mtime(abs) ?? -1);
	};
	for (const match of body.matchAll(HEADER_RE)) mark(match[1]);
	const target = pathOf(result.input);
	if (target && ["read", "edit", "write"].includes(result.toolName)) mark(target);
	if (result.toolName === "bash") {
		const command = field(result.input, "command");
		if (typeof command === "string") {
			const toolCwd = field(result.input, "cwd");
			const base = typeof toolCwd === "string" && toolCwd ? nodePath.resolve(cwd, toolCwd) : cwd;
			for (const abs of viewedPaths(command, base)) {
				const time = mtime(abs);
				if (time !== undefined) seen.set(abs, time);
			}
		}
	}
}

/** Why this call must read first, or undefined when it may go ahead. */
export function check(seen: SeenMap, cwd: string, call: ToolEvent): { path: string; why: "unseen" | "changed" } | undefined {
	if (call.toolName === "edit") {
		// Hashline and patch edits carry their own anchors; omp's seen-line guard checks those.
		if (field(call.input, "old_string") === undefined) return undefined;
		const raw = pathOf(call.input);
		if (!raw) return undefined;
		const abs = resolve(cwd, raw);
		return seen.has(abs) ? undefined : { path: raw, why: "unseen" };
	}
	if (call.toolName === "write") {
		const raw = pathOf(call.input);
		if (!raw) return undefined;
		const abs = resolve(cwd, raw);
		const now = mtime(abs);
		if (now === undefined) return undefined; // a new file
		const at = seen.get(abs);
		if (at === undefined) return { path: raw, why: "unseen" };
		if (at >= 0 && now > at) return { path: raw, why: "changed" };
	}
	return undefined;
}

export function reason(path: string, why: "unseen" | "changed", tool: string): string {
	const what = why === "unseen"
		? `You have not read ${path} in this session, so this ${tool} is based on a guess about its contents.`
		: `${path} changed on disk after you last read it, so this write would overwrite changes you have not seen.`;
	return [MARKER, `The ${tool} was not run. ${what}`, `Run read ${path} first, then send the ${tool} again using what it shows.`, `</system-interrupt>`].join("\n");
}

/** Rebuild the seen set from the session after a restart or resume. */
export function seedFromBranch(seen: SeenMap, cwd: string, branch: readonly SessionEntry[]): void {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const message = entry?.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
				if (call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") {
					calls.set(call.id, { name: call.name, args: call.arguments });
				}
			}
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			recordResult(seen, cwd, {
				toolName: call?.name ?? message.toolName ?? "",
				input: call?.args ?? {},
				isError: message.isError === true,
				content: message.content as ToolResult["content"],
			});
		}
	}
	// Older mtimes are unreliable after a restart; keep the files as seen without a change check.
	for (const key of seen.keys()) seen.set(key, -1);
}

export default function (pi: {
	on(event: "tool_call", handler: (event: ToolEvent, ctx?: Ctx) => { block?: boolean; reason?: string } | undefined): void;
	on(event: "tool_result", handler: (event: ToolResult, ctx?: Ctx) => void): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	if (MODE === "off") return;
	const seen: SeenMap = new Map();
	let lastRefused: string | undefined;
	let refusals = 0;

	const reseed = (_event: unknown, ctx: Ctx): void => {
		seen.clear();
		lastRefused = undefined;
		refusals = 0;
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) seedFromBranch(seen, cwdOf(ctx), branch);
		} catch {
			// An unreadable session starts with nothing seen.
		}
	};
	pi.logger?.warn?.("strata read-before-edit loaded", { mode: MODE });
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", (event, ctx) => {
		recordResult(seen, cwdOf(ctx), event);
	});

	pi.on("tool_call", (event, ctx) => {
		const found = check(seen, cwdOf(ctx), event);
		if (!found) return undefined;
		const key = JSON.stringify([event.toolName, found.path, found.why, field(event.input, "old_string") ?? field(event.input, "content")]);
		refusals = key === lastRefused ? refusals + 1 : 1;
		lastRefused = key;
		const fields = { toolName: event.toolName, path: found.path, why: found.why, attempt: refusals, mode: MODE };
		if (MODE !== "on") {
			pi.logger?.warn?.("read-before-edit would refuse", fields);
			return undefined;
		}
		if (refusals > LET_THROUGH_AFTER) {
			pi.logger?.warn?.("read-before-edit letting a repeated call through", fields);
			return undefined;
		}
		pi.logger?.warn?.("read-before-edit refused", fields);
		return { block: true, reason: reason(found.path, found.why, event.toolName) };
	});
}
