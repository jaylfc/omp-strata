/**
 * Lessons: short, earned rules shown at the moment they apply.
 *
 * `agent/lessons.jsonl` holds one lesson per line:
 *   {"id": "L01", "tags": ["text:decodeURI", "path:**\/server/**"], "lesson": "...", "source": "...", "added": "2026-10-06"}
 *
 * Tags:
 *   path:<glob>   a file the model reads, edits or writes, or a path word in a bash command
 *   cmd:<regex>   a bash command or eval cell
 *   text:<regex>  the text of a file it reads, or of an edit or write
 *   topic:<regex> the text of a todo or goal call
 * Regexes are case-insensitive. A bare tag is a path glob.
 *
 * After a tool result that matches, up to 3 lessons not yet shown in this
 * session are added after that result (omp's additionalContext), each as
 * "[lesson ID] text". A lesson is shown once per session; a restart re-reads
 * the session and skips lessons already shown.
 *
 * The `lesson_propose` tool lets the agent suggest a lesson. It appends to
 * `agent/lessons-proposed.jsonl`; a person (or Claude) curates proposals into
 * the repo's `agent/lessons.jsonl`. apply.sh never overwrites the proposals,
 * and this extension never writes lessons.jsonl.
 *
 * Lessons come only from probe-confirmed failures: a proposal is accepted
 * only after a probe failed in this session (a verify_item run or a probe
 * command that exited non-zero), and that probe's command and exit code are
 * saved with it. A gate's refusal is not a failure. A verifier that learns
 * from its own rejections drifts (Cheap Verifiers, arXiv 2609.01345).
 *
 * OMP_STRATA_LESSONS: on (default) or off. OMP_STRATA_LESSONS_FILE and
 * OMP_STRATA_LESSONS_PROPOSED override the two paths.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { classifyResult, verificationOf } from "./done-gate.ts";

export const MAX_PER_RESULT = 3;
export const MAX_LESSON_CHARS = 320;
const HEADER_RE = /^\[([^\]#\n]+)#[0-9A-Fa-f]{3,8}\]/gm;
const SHOWN_RE = /\[lesson ([\w.-]+)\]/g;

export interface Lesson {
	id: string;
	tags: string[];
	lesson: string;
	source?: string;
	added?: string;
}

interface Matcher {
	kind: "path" | "cmd" | "text" | "topic";
	re: RegExp;
}

export interface CompiledLesson extends Lesson {
	matchers: Matcher[];
}

const HERE = (() => {
	try {
		return (import.meta as { dir?: string }).dir ?? nodePath.dirname(new URL(import.meta.url).pathname);
	} catch {
		return process.cwd();
	}
})();

export function lessonsFile(): string {
	return process.env.OMP_STRATA_LESSONS_FILE || nodePath.join(HERE, "..", "lessons.jsonl");
}

export function proposedFile(): string {
	return process.env.OMP_STRATA_LESSONS_PROPOSED || nodePath.join(HERE, "..", "lessons-proposed.jsonl");
}

/** Glob to regex: **, *, ?, {a,b}. Matches the whole path or any trailing part of it. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				out += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end < 0) {
				out += "\\{";
				continue;
			}
			out += `(?:${glob.slice(i + 1, end).split(",").map(part => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
			i = end;
		} else {
			out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`(?:^|/)${out}$`, "i");
}

export function compile(lessons: Lesson[]): CompiledLesson[] {
	const out: CompiledLesson[] = [];
	for (const lesson of lessons) {
		if (!lesson || typeof lesson.id !== "string" || typeof lesson.lesson !== "string" || !Array.isArray(lesson.tags)) continue;
		const matchers: Matcher[] = [];
		for (const tag of lesson.tags) {
			if (typeof tag !== "string" || !tag.trim()) continue;
			const m = /^(path|cmd|text|topic):(.*)$/s.exec(tag.trim());
			const kind = (m?.[1] ?? "path") as Matcher["kind"];
			const body = m ? m[2] : tag.trim();
			try {
				matchers.push({ kind, re: kind === "path" ? globToRegExp(body) : new RegExp(body, "i") });
			} catch {
				// A bad tag disables only itself.
			}
		}
		if (matchers.length) out.push({ ...lesson, lesson: lesson.lesson.slice(0, MAX_LESSON_CHARS), matchers });
	}
	return out;
}

export function loadLessons(file = lessonsFile()): CompiledLesson[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lessons: Lesson[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trim().startsWith("//")) continue;
		try {
			lessons.push(JSON.parse(line));
		} catch {
			// Skip a malformed line.
		}
	}
	return compile(lessons);
}

function field(input: unknown, key: string): unknown {
	return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map(block => String((block as { text?: unknown }).text ?? ""))
		.join("\n");
}

export interface Facets {
	paths: string[];
	cmd: string;
	text: string;
	topic: string;
}

/** What a tool result exposes to the tags. */
export function facetsOf(result: { toolName: string; input: unknown; content?: unknown }): Facets {
	const facets: Facets = { paths: [], cmd: "", text: "", topic: "" };
	const name = result.toolName;
	if (name === "read" || name === "edit" || name === "write" || name === "ast_edit") {
		for (const key of ["path", "file_path", "file"]) {
			const value = field(result.input, key);
			if (typeof value === "string" && value.trim()) facets.paths.push(value.trim().replace(/\?.*$/, "").replace(/:\d+(?:-\d+)?$/, ""));
		}
		const editText = ["content", "new_string", "input", "old_string"].map(k => field(result.input, k)).filter(v => typeof v === "string").join("\n");
		for (const match of editText.matchAll(HEADER_RE)) facets.paths.push(match[1].trim());
		facets.text = name === "read" ? textOf(result.content) : editText;
	} else if (name === "bash") {
		facets.cmd = String(field(result.input, "command") ?? "");
		for (const word of facets.cmd.split(/[\s'"`;&|<>()=]+/)) if (word.includes("/") || /\.\w{1,5}$/.test(word)) facets.paths.push(word);
	} else if (name === "eval") {
		facets.cmd = String(field(result.input, "code") ?? "");
	} else if (name === "todo" || name === "goal") {
		facets.topic = JSON.stringify(result.input ?? {});
	}
	return facets;
}

export function matches(lesson: CompiledLesson, facets: Facets): boolean {
	return lesson.matchers.some(m => {
		if (m.kind === "path") return facets.paths.some(p => m.re.test(p));
		if (m.kind === "cmd") return !!facets.cmd && m.re.test(facets.cmd);
		if (m.kind === "text") return !!facets.text && m.re.test(facets.text);
		return !!facets.topic && m.re.test(facets.topic);
	});
}

/** Lessons to show after this result; marks them shown. */
export function pick(lessons: CompiledLesson[], shown: Set<string>, facets: Facets, max = MAX_PER_RESULT): CompiledLesson[] {
	const out: CompiledLesson[] = [];
	for (const lesson of lessons) {
		if (out.length >= max) break;
		if (shown.has(lesson.id) || !matches(lesson, facets)) continue;
		out.push(lesson);
		shown.add(lesson.id);
	}
	return out;
}

export function render(picked: CompiledLesson[]): string {
	return ["<lessons>", "Earned rules that apply to what you just did:", ...picked.map(l => `[lesson ${l.id}] ${l.lesson}`), "</lessons>"].join("\n");
}

/** Lesson ids already shown in this session. */
/** The newest probe failure in a session branch. */
export function lastFailureInBranch(branch: readonly unknown[]): Failure | undefined {
	const calls = new Map<string, { name: string; args: unknown }>();
	let last: Failure | undefined;
	for (const raw of branch) {
		const message = (raw as { message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown } })?.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
				if (b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") calls.set(b.id, { name: b.name, args: b.arguments });
			}
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			last = failureOf({ toolName: call?.name ?? message.toolName ?? "", input: call?.args ?? {}, content: message.content, details: message.details, isError: message.isError }) ?? last;
		}
	}
	return last;
}

export function shownInBranch(branch: readonly unknown[]): Set<string> {
	const shown = new Set<string>();
	for (const entry of branch) {
		let text: string;
		try {
			text = JSON.stringify(entry);
		} catch {
			continue;
		}
		if (!text.includes("[lesson ")) continue;
		for (const match of text.matchAll(SHOWN_RE)) shown.add(match[1]);
	}
	return shown;
}

export interface Failure {
	command: string;
	exit: number | string;
}

/** A probe that ran and failed: a verify_item with a non-zero exit, or a probe command that exited non-zero. Refusals are never failures. */
export function failureOf(result: { toolName: string; input: unknown; content?: unknown; details?: unknown; isError?: boolean }): Failure | undefined {
	const verified = verificationOf(result);
	if (verified) return verified.exit !== 0 ? { command: verified.command, exit: verified.exit } : undefined;
	const probe = classifyResult(result);
	if (probe?.kind !== "fail") return undefined;
	const exit = field(result.details, "exitCode");
	if (typeof exit === "number" && exit !== 0) return { command: probe.command, exit };
	return result.isError ? { command: probe.command, exit: "error" } : undefined;
}

export function proposal(params: { lesson?: unknown; tags?: unknown; evidence?: unknown }, now = new Date(), failure?: Failure): { ok: true; line: string } | { ok: false; error: string } {
	if (!failure) return { ok: false, error: "lessons come from probe-confirmed failures: no probe has failed in this session. Run the probe that shows the failure (verify_item), then propose the lesson." };
	const lesson = typeof params.lesson === "string" ? params.lesson.trim() : "";
	if (!lesson) return { ok: false, error: "lesson is required" };
	if (lesson.length > MAX_LESSON_CHARS) return { ok: false, error: `lesson is ${lesson.length} characters; keep it under ${MAX_LESSON_CHARS}` };
	const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 6) : [];
	if (tags.length === 0) return { ok: false, error: 'tags are required, e.g. ["path:**/server/*.js", "cmd:pkill"]' };
	const row = { tags, lesson, evidence: typeof params.evidence === "string" ? params.evidence.slice(0, 500) : undefined, probe: { command: failure.command.slice(0, 300), exit: failure.exit }, proposed: now.toISOString() };
	return { ok: true, line: JSON.stringify(row) };
}

type Logger = { warn?: (message: string, fields?: Record<string, unknown>) => void };
interface Ctx {
	sessionManager?: { getBranch?: () => readonly unknown[] };
}

interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

export default function (pi: {
	on(event: "tool_result", handler: (event: { toolName: string; input: unknown; content?: unknown; details?: unknown; isError?: boolean }, ctx?: Ctx) => { additionalContext?: string } | undefined): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
	registerTool?: (tool: ToolDefinition) => void;
	typebox?: { Type: { Object: (props: Record<string, unknown>) => unknown; String: (opts?: Record<string, unknown>) => unknown; Array: (item: unknown, opts?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
	logger?: Logger;
}): void {
	const mode = (process.env.OMP_STRATA_LESSONS ?? "on").trim().toLowerCase();
	if (mode === "off") return;
	const lessons = loadLessons();
	let shown = new Set<string>();
	let lastFailure: Failure | undefined;
	pi.logger?.warn?.("strata lessons loaded", { mode, lessons: lessons.length, file: lessonsFile() });

	const reseed = (_event: unknown, ctx: Ctx): void => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			shown = Array.isArray(branch) ? shownInBranch(branch) : new Set();
			lastFailure = Array.isArray(branch) ? lastFailureInBranch(branch) : undefined;
		} catch {
			shown = new Set();
		}
	};
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", event => {
		try {
			lastFailure = failureOf(event) ?? lastFailure;
		} catch {
			// Not a probe.
		}
		if (lessons.length === 0) return undefined;
		let picked: CompiledLesson[];
		try {
			picked = pick(lessons, shown, facetsOf(event));
		} catch {
			return undefined;
		}
		if (picked.length === 0) return undefined;
		pi.logger?.warn?.("lessons: shown", { toolName: event.toolName, ids: picked.map(l => l.id) });
		return { additionalContext: render(picked) };
	});

	const T = pi.typebox?.Type;
	if (!pi.registerTool || !T) return;
	pi.registerTool({
		name: "lesson_propose",
		label: "Propose lesson",
		description: "Propose a short rule you learned the hard way (a bug you caused, evidence that misled you). A person reviews it before it is shown to future sessions.",
		parameters: T.Object({
			lesson: T.String({ description: "the rule, under 300 characters, general (not tied to one task)" }),
			tags: T.Array(T.String(), { description: "when to show it: path:<glob>, cmd:<regex>, text:<regex>, topic:<regex>" }),
			evidence: T.Optional(T.String({ description: "what happened, one line" })),
		}),
		async execute(_id, params) {
			const row = proposal(params, new Date(), lastFailure);
			if (!row.ok) return { content: [{ type: "text", text: row.error }], isError: true };
			try {
				fs.mkdirSync(nodePath.dirname(proposedFile()), { recursive: true });
				fs.appendFileSync(proposedFile(), `${row.line}\n`);
			} catch (error) {
				return { content: [{ type: "text", text: `could not save the proposal: ${(error as Error).message}` }], isError: true };
			}
			pi.logger?.warn?.("lessons: proposed", { file: proposedFile() });
			return { content: [{ type: "text", text: "Proposal saved for review. Continue with your task." }] };
		},
	});
}
