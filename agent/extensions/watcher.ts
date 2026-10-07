/**
 * Watcher: a second model on another machine judges the coder's progress.
 *
 * The coder has one Strata slot and one prefix cache, so the watcher never
 * calls the coder's server. Every OMP_STRATA_WATCHER_EVERY tool results (8),
 * or every OMP_STRATA_WATCHER_MINUTES (10) while a run is active, it builds a
 * compact digest from the session branch and asks the watcher model for a
 * typed verdict:
 *
 *   state       progressing | looping | drifting | stuck_env | overclaiming | waiting
 *   confidence  0..1
 *   steer       one line: what the coder should do next
 *
 * The digest is computed by code (experiment 026, System One lesson from 021):
 * the current todo item and goal, the last 12 tool calls with truncated
 * arguments, results and exit status, files changed, commits and probes
 * since the item started, time on the item, repeat counts, guard events and
 * any done/complete claims with or without evidence. The same function
 * builds the digests of the lab replay set, so replay numbers carry over.
 *
 * Two kinds of watcher endpoint:
 * - api=chat: an OpenAI-compatible chat model (System Two, e.g. the Mac's
 *   LM Studio). It answers a short JSON object.
 * - api=system1: a decision model on llama.cpp `/v1/systemone` (Kev-4B,
 *   imajev). One `choice` over the six states with described options that
 *   carry the computed facts, and one `choice` over templated steers.
 *   Options are shuffled per call (first-option bias).
 * - api=rules: no model; the rule baseline below (also the fallback when the
 *   endpoint fails).
 *
 * Modes (OMP_STRATA_WATCHER): off, log (default), steer.
 * - log: nothing reaches the coder. Each check is appended (digest, facts,
 *   verdict, latency) to ~/.config/omp-strata/watcher.jsonl and logged as
 *   `watcher: verdict`. That file is the label source for the weekly routine.
 * - steer: a steer is sent only when two consecutive checks give the same
 *   non-progress state at or above the confidence threshold, at most once per
 *   OMP_STRATA_WATCHER_STEER_GAP_MIN minutes (15). A looping verdict is left
 *   to the fail-loop guard when the guard fired inside the window. A
 *   confirmed overclaiming verdict also arms the done gate: the next
 *   `todo done` is checked as if OMP_STRATA_DONE_GATE_TODO=on.
 *
 * Checks never block the coder: the request runs in the background, one at a
 * time, with a timeout; tool results that arrive meanwhile are not delayed.
 *
 * Settings come from the environment, then from WATCHER_* keys in
 * ~/.config/omp-strata/settings.env:
 *   OMP_STRATA_WATCHER            off | log | steer          (WATCHER_MODE)
 *   OMP_STRATA_WATCHER_API        chat | system1 | rules     (WATCHER_API)
 *   OMP_STRATA_WATCHER_URL        base URL, e.g. http://mac:1234/v1 (WATCHER_URL)
 *   OMP_STRATA_WATCHER_MODEL      model id for api=chat      (WATCHER_MODEL)
 *   OMP_STRATA_WATCHER_THRESHOLD  confidence cutoff          (WATCHER_THRESHOLD)
 *   OMP_STRATA_WATCHER_EVERY, _MINUTES, _TIMEOUT_S, _STEER_GAP_MIN, _LOG
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { armDoneGate, changedPaths, classifyResult, claimsOf, newState, record, textOf, type BranchEntry } from "./done-gate.ts";

export const STATES = ["progressing", "looping", "drifting", "stuck_env", "overclaiming", "waiting"] as const;
export type WatchState = (typeof STATES)[number];
export const STEERS = ["none", "commit_now", "verify_item", "stop_side_work", "new_approach", "fix_environment", "back_to_item"] as const;
export type SteerId = (typeof STEERS)[number];
export type WatcherMode = "off" | "log" | "steer";
export type WatcherApi = "chat" | "system1" | "rules";

export const WINDOW = 12;
export const REPEAT_SPAN = Number(process.env.OMP_STRATA_WATCHER_REPEAT_SPAN) > 0 ? Number(process.env.OMP_STRATA_WATCHER_REPEAT_SPAN) : 24;
/** Guard events that mean "a loop was caught". Operator pause and done-gate refusals are not loop signals. */
const LOOP_GUARDS = new Set(["tool_call_loop_blocked", "tool-call-loop-redirect", "thinking-loop-redirect", "thinking-loop", "guard-steer", "thinking_loop_detected"]);

// ---------------------------------------------------------------------------
// Reading the branch

export interface CallRec {
	id: string;
	name: string;
	args: Record<string, unknown>;
	at: number;
	isError: boolean;
	exit?: number;
	text: string;
	details?: unknown;
	/** reason="..." of a <system-interrupt> in the result: the call was refused by an extension. */
	interrupt?: string;
}

export interface GuardEvent {
	/** Number of tool calls before the event. */
	afterCall: number;
	kind: string;
}

export interface Snapshot {
	calls: CallRec[];
	guards: GuardEvent[];
	objective?: string;
	/** Task text -> index of the first call after which the task was in progress (or first seen). */
	itemStart: Map<string, number>;
	current?: { content: string; phase?: string; open: number; done: number; total: number };
	lastReply?: { afterCall: number; text: string };
	jobsPending: number;
	/** Index of the last successful todo call (the start of "no item" stretches). */
	lastTodoCall: number;
	/** Working directory from the session header, when the branch carries it. */
	cwd?: string;
}

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function timeOf(entry: BranchEntry): number {
	const raw = entry?.message?.timestamp ?? entry?.timestamp;
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const ms = Date.parse(raw);
		if (!Number.isNaN(ms)) return ms;
	}
	return 0;
}

const INTERRUPT_RE = /<system-interrupt reason="([^"]+)"/;
const GUARD_CUSTOM = new Set(["tool-call-loop-redirect", "thinking-loop-redirect"]);

/** Read calls, todo state, goal, guard events and the last reply from a session branch (live or replay). */
export function snapshot(branch: readonly BranchEntry[]): Snapshot {
	const snap: Snapshot = { calls: [], guards: [], itemStart: new Map(), jobsPending: 0, lastTodoCall: -1 };
	const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
	const jobs = new Set<string>();
	for (const raw of branch) {
		const entry = raw as BranchEntry & { data?: unknown; mode?: string };
		if (!entry) continue;
		if (entry.type === "session" && typeof (entry as { cwd?: unknown }).cwd === "string") {
			snap.cwd = (entry as { cwd: string }).cwd;
			continue;
		}
		if (entry.type === "mode_change") {
			const goal = obj(obj(entry.data).goal);
			if (typeof goal.objective === "string") snap.objective = goal.status === "active" || goal.status === undefined ? goal.objective : snap.objective;
			continue;
		}
		if (entry.type === "custom_message") {
			if (entry.customType && GUARD_CUSTOM.has(entry.customType)) snap.guards.push({ afterCall: snap.calls.length, kind: entry.customType });
			if (entry.customType === "async-result") for (const m of textOf(entry.content).matchAll(/(?:── Job |Background job )(\S+)/g)) jobs.delete(m[1]);
			continue;
		}
		const message = entry.message;
		if (!message) continue;
		if (message.role === "user") {
			const text = textOf(message.content);
			if (/^\s*Loop guard:/.test(text)) snap.guards.push({ afterCall: snap.calls.length, kind: "guard-steer" });
			continue;
		}
		if (message.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content : [];
			let reply = "";
			for (const block of blocks) {
				const b = obj(block);
				if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") pending.set(b.id, { name: b.name, args: obj(b.arguments) });
				if (b.type === "text" && typeof b.text === "string") reply += b.text;
			}
			const err = (message as { errorMessage?: unknown }).errorMessage;
			if (typeof err === "string" && /loop detected/i.test(err)) snap.guards.push({ afterCall: snap.calls.length, kind: "thinking-loop" });
			if (reply.trim()) snap.lastReply = { afterCall: snap.calls.length, text: reply.trim() };
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = message.toolCallId ? pending.get(message.toolCallId) : undefined;
		const text = textOf(message.content);
		const details = message.details;
		const isError = message.isError === true;
		const code = obj(details).exitCode;
		const exited = /Command exited with code (\d+)/.exec(text);
		const exit = typeof code === "number" ? code : exited ? Number(exited[1]) : isError ? undefined : 0;
		const rec: CallRec = {
			id: message.toolCallId ?? "",
			name: call?.name ?? message.toolName ?? "",
			args: call?.args ?? {},
			at: timeOf(entry),
			isError,
			exit,
			text,
			details,
			interrupt: INTERRUPT_RE.exec(text)?.[1],
		};
		snap.calls.push(rec);
		if (rec.interrupt) snap.guards.push({ afterCall: snap.calls.length - 1, kind: rec.interrupt });
		const job = /Backgrounded as job ([^\s;]+)/i.exec(text);
		if (job) jobs.add(job[1]);
		if (rec.name === "todo" && !isError) {
			const phases = obj(details).phases;
			if (Array.isArray(phases)) {
				snap.lastTodoCall = snap.calls.length - 1;
				let current: Snapshot["current"];
				let open = 0;
				let done = 0;
				let total = 0;
				let firstPending: { content: string; phase?: string } | undefined;
				for (const p of phases) {
					const phase = obj(p);
					const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
					for (const t of tasks) {
						const task = obj(t);
						const content = String(task.content ?? "");
						if (!content) continue;
						total++;
						const status = String(task.status ?? "");
						if (status === "completed") done++;
						else if (status !== "abandoned") open++;
						if (status === "in_progress" && !current) current = { content, phase: String(phase.name ?? ""), open: 0, done: 0, total: 0 };
						if (status === "pending" && !firstPending) firstPending = { content, phase: String(phase.name ?? "") };
						if (status === "in_progress" && !snap.itemStart.has(content)) snap.itemStart.set(content, snap.calls.length - 1);
					}
				}
				const pick = current ?? (firstPending ? { ...firstPending, open: 0, done: 0, total: 0 } : undefined);
				if (pick) {
					if (!snap.itemStart.has(pick.content)) snap.itemStart.set(pick.content, snap.calls.length - 1);
					snap.current = { ...pick, open, done, total };
				} else snap.current = undefined;
			}
		}
	}
	snap.jobsPending = jobs.size;
	return snap;
}

// ---------------------------------------------------------------------------
// Facts

export interface Claim {
	call: number;
	kind: "todo done" | "goal complete";
	label: string;
	evidenced: boolean;
	refused: boolean;
}

export interface Facts {
	objective?: string;
	item?: string;
	phase?: string;
	itemsOpen: number;
	itemsDone: number;
	itemsTotal: number;
	itemMinutes: number;
	itemCalls: number;
	windowMinutes: number;
	editsItem: number;
	filesItem: string[];
	commitsItem: number;
	editsSinceCommit: number;
	minutesSinceCommit: number;
	probesPassItem: number;
	probesFailItem: number;
	passAfterLastEdit: boolean;
	newScriptsItem: string[];
	editsWindow: number;
	readsWindow: number;
	errorsWindow: number;
	envErrorsWindow: number;
	waitsWindow: number;
	jobsPending: number;
	maxCommandRepeat: number;
	repeatedCommand?: string;
	maxFileReads: number;
	rereadFile?: string;
	guardWindow: number;
	guardKinds: string[];
	/** Other extension refusals in the window (done_gate, goal_verify, operator_pause, ...). */
	otherRefusals: string[];
	claims: Claim[];
	lastReply?: string;
}

const ENV_ERR_RE = /ECONNREFUSED|EADDRINUSE|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|address already in use|connection refused|command not found|Cannot find (?:module|package)|No such file or directory|permission denied|out of memory|\bOOM\b|HTTP (?:5\d\d|429)|\b(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Timeout)|timed out|Timeout exceeded|net::ERR_|socket hang up|no_judge_model|model (?:is )?not loaded|ENOSPC/i;
const SCRIPT_RE = /\.(?:m?js|cjs|ts|py|sh)$/;
const HEREDOC_RE = /cat\s+>\s*([^\s<]+)\s*<</g;

function oneLine(text: string, max: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function commandOf(call: CallRec): string {
	return String(call.args.command ?? "");
}

function isCommit(call: CallRec): boolean {
	return call.name === "bash" && /\bgit\b[^|;&]*\bcommit\b/.test(commandOf(call)) && !call.isError && !/nothing to commit|no changes added/i.test(call.text);
}

function readKey(call: CallRec): string | undefined {
	if (call.name !== "read") return undefined;
	const p = String(call.args.path ?? call.args.file_path ?? "");
	return p.replace(/:\d+(?:-\d+)?$/, "") || undefined;
}

function scriptsWritten(call: CallRec): string[] {
	const out: string[] = [];
	if ((call.name === "write" || call.name === "edit") && !call.isError) {
		for (const p of changedPaths({ toolName: call.name, input: call.args, content: [{ type: "text", text: call.text }], isError: call.isError })) if (SCRIPT_RE.test(p) && /(?:^|\/)(?:tools|scripts|tmp)\/|^\/tmp\//.test(p)) out.push(p);
	}
	if (call.name === "bash") for (const m of commandOf(call).matchAll(HEREDOC_RE)) if (SCRIPT_RE.test(m[1])) out.push(m[1]);
	return out;
}

/**
 * Same file. Relative paths are resolved against the session's working directory when it is known; without it
 * only identical paths match. A shared suffix alone (a.js vs src/a.js, a.js vs /a.js) is never enough.
 */
export function samePath(a: string, b: string, cwd?: string): boolean {
	const norm = (p: string) => (cwd ? path.resolve(cwd, p) : path.normalize(p));
	return norm(a) === norm(b);
}

function normalizedCommand(call: CallRec): string | undefined {
	if (call.name === "bash") return `bash:${commandOf(call).replace(/\s+/g, " ").trim()}`;
	if (call.name === "eval") return `eval:${String(call.args.code ?? call.args.input ?? "").replace(/\s+/g, " ").trim()}`;
	return undefined;
}

/** Facts for the window that ends at the last call of the snapshot. */
export function computeFacts(snap: Snapshot, window = WINDOW): Facts {
	const calls = snap.calls;
	const end = calls.length;
	const winStart = Math.max(0, end - window);
	const repStart = Math.max(0, end - REPEAT_SPAN);
	const item = snap.current?.content;
	const itemStart = item !== undefined ? Math.max(0, snap.itemStart.get(item) ?? 0) : Math.max(0, snap.lastTodoCall + 1);
	const last = calls[end - 1];
	const now = last?.at ?? 0;

	// Done-gate replay: evidence for each claim, as the gate would see it at that moment.
	const gate = newState();
	const claims: Claim[] = [];
	let editsItem = 0;
	let commitsItem = 0;
	let probesPass = 0;
	let probesFail = 0;
	let lastEditIdx = -1;
	let lastPassIdx = -1;
	let lastCommitIdx = -1;
	let editsSinceCommit = 0;
	const files = new Set<string>();
	const scripts = new Set<string>();
	for (let i = 0; i < end; i++) {
		const c = calls[i];
		const input = c.args;
		if (i >= winStart) {
			const op = input.op;
			const claimKind = c.name === "todo" && op === "done" ? "todo done" : c.name === "goal" && op === "complete" ? "goal complete" : undefined;
			if (claimKind) {
				const found = claimsOf(gate, c.name, input, undefined, "probe");
				const refused = !!c.interrupt && /done_gate|goal_verify/.test(c.interrupt);
				const label = claimKind === "goal complete" ? "the goal" : String(input.task ?? input.phase ?? (found?.claims.length ? `${found.claims.length} open items` : "all items"));
				claims.push({ call: i, kind: claimKind, label: oneLine(label, 80), evidenced: !!found && found.claims.every(cl => !!cl.evidence), refused });
			}
		}
		const at = c.at || gate.clock + 1;
		record(gate, { toolName: c.name, input, isError: c.isError, content: [{ type: "text", text: c.text }], details: c.details }, at);
		const changed = changedPaths({ toolName: c.name, input, isError: c.isError, content: [{ type: "text", text: c.text }] });
		if (changed.length) {
			lastEditIdx = i;
			editsSinceCommit++;
			if (i >= itemStart) {
				editsItem++;
				for (const p of changed) files.add(p);
			}
		}
		if (isCommit(c)) {
			lastCommitIdx = i;
			editsSinceCommit = 0;
			if (i >= itemStart) commitsItem++;
		}
		const probe = classifyResult({ toolName: c.name, input, isError: c.isError, content: [{ type: "text", text: c.text }], details: c.details });
		if (probe?.kind === "pass") {
			lastPassIdx = i;
			if (i >= itemStart) probesPass++;
		}
		if (probe?.kind === "fail" && i >= itemStart) probesFail++;
		if (i >= itemStart) for (const s of scriptsWritten(c)) scripts.add(s);
	}

	// Repeats count only while nothing changed: re-running a check after an edit, or re-reading a file after
	// editing it, is progress (026 replay: the audit re-run after each maps.js fix read as a loop).
	const repeats = new Map<string, number>();
	const reads = new Map<string, number>();
	const bestRepeat = new Map<string, number>();
	const bestRead = new Map<string, number>();
	for (let i = repStart; i < end; i++) {
		const c = calls[i];
		const changed = changedPaths({ toolName: c.name, input: c.args, isError: c.isError, content: [{ type: "text", text: c.text }] });
		if (changed.length) {
			repeats.clear();
			for (const p of changed) for (const k of [...reads.keys()]) if (samePath(p, k, snap.cwd)) reads.delete(k);
			continue;
		}
		const key = normalizedCommand(c);
		if (key) {
			const n = (repeats.get(key) ?? 0) + 1;
			repeats.set(key, n);
			bestRepeat.set(key, Math.max(bestRepeat.get(key) ?? 0, n));
		}
		const r = readKey(c);
		if (r) {
			const n = (reads.get(r) ?? 0) + 1;
			reads.set(r, n);
			bestRead.set(r, Math.max(bestRead.get(r) ?? 0, n));
		}
	}
	const topRepeat = [...bestRepeat.entries()].sort((a, b) => b[1] - a[1])[0];
	const topRead = [...bestRead.entries()].sort((a, b) => b[1] - a[1])[0];
	const win = calls.slice(winStart, end);
	const guards = snap.guards.filter(g => g.afterCall >= winStart && g.afterCall <= end && LOOP_GUARDS.has(g.kind));
	const refusals = snap.guards.filter(g => g.afterCall >= winStart && g.afterCall <= end && !LOOP_GUARDS.has(g.kind));
	const minutes = (a: number, b: number) => (a && b ? Math.max(0, Math.round((b - a) / 60000)) : 0);
	const commitAt = lastCommitIdx >= 0 ? calls[lastCommitIdx].at : calls[itemStart]?.at;
	return {
		objective: snap.objective,
		item,
		phase: snap.current?.phase,
		itemsOpen: snap.current?.open ?? 0,
		itemsDone: snap.current?.done ?? 0,
		itemsTotal: snap.current?.total ?? 0,
		itemMinutes: minutes(calls[itemStart]?.at ?? 0, now),
		itemCalls: end - itemStart,
		windowMinutes: minutes(win[0]?.at ?? 0, now),
		editsItem,
		filesItem: [...files].slice(-6),
		commitsItem,
		editsSinceCommit,
		minutesSinceCommit: minutes(commitAt ?? 0, now),
		probesPassItem: probesPass,
		probesFailItem: probesFail,
		passAfterLastEdit: lastPassIdx > lastEditIdx,
		newScriptsItem: [...scripts].slice(-6),
		editsWindow: win.filter(c => !c.isError && (["edit", "write", "ast_edit"].includes(c.name) || changedPaths({ toolName: c.name, input: c.args, isError: c.isError, content: [{ type: "text", text: c.text }] }).length > 0)).length,
		readsWindow: win.filter(c => c.name === "read" || c.name === "grep" || c.name === "glob").length,
		errorsWindow: win.filter(c => c.isError).length,
		envErrorsWindow: win.filter(c => (c.isError || (c.exit ?? 0) !== 0) && ENV_ERR_RE.test(c.text.slice(-4000))).length,
		waitsWindow: win.filter(c => c.name === "wait" || c.name === "job" || c.name === "await" || (c.name === "bash" && /^\s*sleep\s+\d+\s*(?:;|&&|$)/.test(commandOf(c)))).length,
		jobsPending: snap.jobsPending,
		maxCommandRepeat: topRepeat?.[1] ?? 0,
		repeatedCommand: topRepeat && topRepeat[1] > 1 ? redact(oneLine(topRepeat[0].replace(/^\w+:/, ""), 90)) : undefined,
		maxFileReads: topRead?.[1] ?? 0,
		rereadFile: topRead && topRead[1] > 1 ? topRead[0] : undefined,
		guardWindow: guards.length,
		guardKinds: [...new Set(guards.map(g => g.kind))],
		otherRefusals: [...new Set(refusals.map(g => g.kind))],
		claims,
		lastReply: snap.lastReply && snap.lastReply.afterCall >= winStart ? redact(oneLine(snap.lastReply.text, 240)) : undefined,
	};
}

// ---------------------------------------------------------------------------
// The digest

function hhmm(ms: number): string {
	if (!ms) return "--:--";
	const d = new Date(ms);
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function target(call: CallRec): string {
	const a = call.args;
	switch (call.name) {
		case "bash":
			return oneLine(String(a.command ?? ""), 110);
		case "read":
		case "write":
		case "edit":
		case "ast_edit":
		case "find":
		case "glob":
			return oneLine(String(a.path ?? a.file_path ?? a.pattern ?? (typeof a.input === "string" ? (/\[([^\]#\n]+)#/.exec(a.input)?.[1] ?? "") : "")), 90);
		case "grep":
			return oneLine(`${String(a.pattern ?? "")} ${String(a.path ?? "")}`, 90);
		case "eval":
			return oneLine(String(a.code ?? a.input ?? ""), 100);
		case "todo":
			return oneLine(`${String(a.op ?? "")} ${String(a.task ?? a.phase ?? "")}`, 90);
		case "goal":
			return String(a.op ?? "");
		case "task":
			return oneLine(String(a.description ?? a.prompt ?? a.agent ?? ""), 80);
		default:
			return oneLine(JSON.stringify(a).slice(0, 200), 80);
	}
}

const NOISE_LINE_RE = /^(?:Wall time:|Command exited with code|\s*$|---|\.\.\.|…)/;

function outcome(call: CallRec): string {
	if (call.interrupt) return `REFUSED (${call.interrupt})`;
	const status = call.isError ? `ERR${call.exit !== undefined ? ` exit ${call.exit}` : ""}` : call.exit && call.exit !== 0 ? `exit ${call.exit}` : "ok";
	if (call.name === "read" || call.name === "write" || call.name === "edit") return call.isError ? `${status}: ${oneLine(call.text, 80)}` : status;
	const lines = call.text.split("\n").filter(l => !NOISE_LINE_RE.test(l));
	const pick = call.isError || (call.exit ?? 0) !== 0 ? (lines.find(l => /error|fail|cannot|not found|refused|denied/i.test(l)) ?? lines[lines.length - 1]) : lines[lines.length - 1];
	return pick ? `${status}: ${oneLine(pick, 90)}` : status;
}

const SECRET_RES: Array<[RegExp, string]> = [
	[/\b(password|passwd|passphrase|pwd)(\s*[:=]?\s*|\s+(?:is\s+)?)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]"],
	[/\bsshpass\s+-p\s*\S+/gi, "sshpass -p [redacted]"],
	[/\b(api[_-]?key|token|secret|authorization)(\s*[:=]\s*|\s+bearer\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]"],
	[/\b(?:sk|ghp|gho|hf|xox[bp])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]"],
];

/** Digests leave the coder's machine and are logged: drop anything that looks like a credential. */
export function redact(text: string): string {
	let out = text;
	for (const [re, sub] of SECRET_RES) out = out.replace(re, sub);
	return out;
}

/** The text the watcher model reads. */
export function renderDigest(snap: Snapshot, facts: Facts, window = WINDOW): string {
	const calls = snap.calls;
	const start = Math.max(0, calls.length - window);
	const lines: string[] = [];
	if (facts.objective) lines.push(`GOAL: ${oneLine(facts.objective, 300)}`);
	lines.push(facts.item ? `CURRENT ITEM: ${oneLine(facts.item, 200)}${facts.phase ? ` (phase ${oneLine(facts.phase, 40)})` : ""}; items done ${facts.itemsDone}/${facts.itemsTotal}` : "CURRENT ITEM: none (no todo list)");
	lines.push(`${facts.item ? "ON THIS ITEM" : "SINCE THE LAST TODO UPDATE"}: ${facts.itemMinutes} min, ${facts.itemCalls} tool calls; edits ${facts.editsItem} on ${facts.filesItem.length} files${facts.filesItem.length ? ` (${facts.filesItem.join(", ")})` : ""}; commits ${facts.commitsItem}; probes passed ${facts.probesPassItem}, failed ${facts.probesFailItem}`);
	lines.push(`SINCE LAST COMMIT: ${facts.minutesSinceCommit} min, ${facts.editsSinceCommit} file edits uncommitted; a probe passed after the last edit: ${facts.passAfterLastEdit ? "yes" : "no"}`);
	if (facts.newScriptsItem.length) lines.push(`NEW SCRIPTS WRITTEN ON THIS ITEM: ${facts.newScriptsItem.length} (${facts.newScriptsItem.join(", ")})`);
	lines.push(`REPEATS WITHOUT A FILE CHANGE BETWEEN (last ${REPEAT_SPAN} calls): most repeated command x${facts.maxCommandRepeat}${facts.repeatedCommand ? ` (${facts.repeatedCommand})` : ""}; most re-read file x${facts.maxFileReads}${facts.rereadFile ? ` (${facts.rereadFile})` : ""}`);
	lines.push(`LOOP-GUARD EVENTS IN WINDOW: ${facts.guardWindow}${facts.guardKinds.length ? ` (${facts.guardKinds.join(", ")})` : ""}${facts.otherRefusals.length ? `; other refusals: ${facts.otherRefusals.join(", ")}` : ""}; environment errors ${facts.envErrorsWindow}; waits ${facts.waitsWindow}; background jobs pending ${facts.jobsPending}`);
	for (const c of facts.claims) lines.push(`CLAIM: ${c.kind} "${c.label}" ${c.evidenced ? "with a passing probe after the last edit" : "WITHOUT a passing probe after the last edit"}${c.refused ? " (refused by the done gate)" : ""}`);
	lines.push(`LAST ${calls.length - start} TOOL CALLS (${facts.windowMinutes} min):`);
	for (let i = start; i < calls.length; i++) {
		const c = calls[i];
		lines.push(`${i - start + 1}. ${hhmm(c.at)} ${c.name} ${target(c)} -> ${outcome(c)}`);
	}
	if (facts.lastReply) lines.push(`LAST REPLY: ${facts.lastReply}`);
	return redact(lines.join("\n"));
}

export function buildDigest(branch: readonly BranchEntry[], window = WINDOW, cwd?: string): { text: string; facts: Facts; calls: number } {
	const snap = snapshot(branch);
	if (cwd) snap.cwd = cwd;
	const facts = computeFacts(snap, window);
	return { text: renderDigest(snap, facts, window), facts, calls: snap.calls.length };
}

// ---------------------------------------------------------------------------
// Rule baseline (no model)

export interface Verdict {
	state: WatchState;
	confidence: number;
	steer: string;
	steerId?: SteerId;
	/** System One: the model's own answer to the steer question (logged, not used). */
	steerChoice?: SteerId;
	probabilities?: Partial<Record<WatchState, number>>;
	source: string;
	ms?: number;
	raw?: unknown;
}

export function ruleVerdict(f: Facts): Verdict {
	const unproven = f.claims.filter(c => !c.evidenced && !c.refused);
	if (unproven.length) return { state: "overclaiming", confidence: 0.8, steerId: "verify_item", steer: steerLine("verify_item", f), source: "rules" };
	if (f.envErrorsWindow >= 3 && f.editsWindow === 0) return { state: "stuck_env", confidence: 0.7, steerId: "fix_environment", steer: steerLine("fix_environment", f), source: "rules" };
	if (f.maxCommandRepeat >= 4 || f.maxFileReads >= 5 || f.guardWindow >= 2) return { state: "looping", confidence: 0.7, steerId: "new_approach", steer: steerLine("new_approach", f), source: "rules" };
	if (f.waitsWindow >= 3 || (f.jobsPending > 0 && f.waitsWindow >= 1 && f.editsWindow === 0)) return { state: "waiting", confidence: 0.6, steerId: "none", steer: "", source: "rules" };
	if (f.newScriptsItem.length >= 3 && f.itemMinutes >= 45 && f.commitsItem === 0) return { state: "drifting", confidence: 0.6, steerId: "stop_side_work", steer: steerLine("stop_side_work", f), source: "rules" };
	return { state: "progressing", confidence: 0.6, steerId: "none", steer: "", source: "rules" };
}

// ---------------------------------------------------------------------------
// Questions

export const STATE_INSTRUCTIONS =
	"You watch an autonomous coding agent working through a todo list toward a goal. From the digest (computed facts and its last tool calls), which state is it in right now? Judge the pattern over the window, not one call.";

/** Option descriptions for the state choice. The computed facts go into the descriptions (System One: facts in labels). */
export function stateOptions(f: Facts): Record<WatchState, string> {
	const unproven = f.claims.filter(c => !c.evidenced && !c.refused);
	return {
		progressing: `Progressing: it changes the files the current item needs, runs checks whose results move forward, commits, or moves to the next item. Here: ${f.editsItem} edits and ${f.commitsItem} commits on this item, ${f.probesPassItem} probes passed.`,
		looping: `Looping: the same command, file read, edit or probe repeats with no new information, or edits undo each other, or the loop guard keeps firing. Here: most repeated command x${f.maxCommandRepeat}, most re-read file x${f.maxFileReads}, ${f.guardWindow} guard events.`,
		drifting: `Drifting off the item: time goes to side work the item does not need, such as writing throwaway walker or probe scripts, tooling, or unrelated polish, while the item's own change sits uncommitted or unverified. Here: ${f.newScriptsItem.length} new scripts on this item, ${f.itemMinutes} min on the item, ${f.editsSinceCommit} edits uncommitted for ${f.minutesSinceCommit} min.`,
		stuck_env: `Stuck on the environment: tools fail for reasons outside the code, such as a server down, a port in use, a missing command or module, a model or network error, or timeouts, and it cannot get past them. Here: ${f.envErrorsWindow} environment errors, ${f.errorsWindow} failed calls in the window.`,
		overclaiming: `Overclaiming: it marks items done, completes the goal, or reports success without a passing check of that item after its last edit. Here: ${unproven.length ? unproven.map(c => `${c.kind} "${c.label}" without a passing probe`).join("; ") : f.claims.length ? "claims made, all with a passing probe" : "no done claim in this window"}.`,
		waiting: `Waiting: it is waiting on a background job, a subagent or a long run, with few new actions; nothing is wrong yet. Here: ${f.waitsWindow} waits, ${f.jobsPending} background jobs pending.`,
	};
}

export const STEER_INSTRUCTIONS = "Which one short instruction would most help the agent right now? Choose none if it is doing fine or only waiting.";

export function steerOptions(): Record<SteerId, string> {
	return {
		none: "No steer: it is progressing or legitimately waiting.",
		commit_now: "Commit the work that already passed its check, then move on.",
		verify_item: "Run the current item's own probe through verify_item before claiming it done.",
		stop_side_work: "Stop building throwaway scripts or side tooling; verify the item with the simplest data-level check and commit.",
		new_approach: "The same step keeps repeating; stop it and try a different approach or a smaller step.",
		fix_environment: "Fix or work around the environment problem (server, port, missing tool) before continuing, or move to another item.",
		back_to_item: "Go back to the current todo item's acceptance criteria; the recent work is off-item.",
	};
}

export function steerLine(id: SteerId, f: Facts): string {
	const item = f.item ? `"${oneLine(f.item, 70)}"` : "the current item";
	switch (id) {
		case "commit_now":
			return `Commit the ${f.editsSinceCommit} uncommitted edits that already passed their check, then move to the next item.`;
		case "verify_item":
			return `Before marking ${item} done, run its own probe through verify_item and read the exit code.`;
		case "stop_side_work":
			return `Stop writing new scripts (${f.newScriptsItem.length} so far on this item). Verify ${item} with the simplest data-level check, commit, and move on.`;
		case "new_approach":
			return `The same step keeps repeating${f.repeatedCommand ? ` (${oneLine(f.repeatedCommand, 60)} x${f.maxCommandRepeat})` : f.rereadFile ? ` (${f.rereadFile} read x${f.maxFileReads})` : ""}. Say in one sentence why it fails, then take a different approach.`;
		case "fix_environment":
			return "The failures look environmental (server, port, tool, model). Fix or route around that first, or move to another item.";
		case "back_to_item":
			return `Return to ${item}: re-read its acceptance criteria and do the next step it needs.`;
		default:
			return "";
	}
}

export const STEER_FOR: Record<WatchState, SteerId> = {
	progressing: "none",
	looping: "new_approach",
	drifting: "stop_side_work",
	stuck_env: "fix_environment",
	overclaiming: "verify_item",
	waiting: "none",
};

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let s = seed >>> 0 || 1;
	for (let i = out.length - 1; i > 0; i--) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export function hashText(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** Body for llama.cpp /v1/systemone (and imajev's server). Options are shuffled by `seed`. */
export function system1Body(digest: string, facts: Facts, seed = hashText(digest)): Record<string, unknown> {
	const opts = stateOptions(facts);
	const steers = steerOptions();
	const criteria: Record<string, string> = {};
	for (const id of seededShuffle(STATES, seed)) criteria[id] = opts[id];
	const steerCriteria: Record<string, string> = {};
	for (const id of seededShuffle(STEERS, seed ^ 0x9e3779b9)) steerCriteria[id] = steers[id];
	return {
		state: digest,
		questions: {
			state: { type: "choice", instructions: STATE_INSTRUCTIONS, criteria },
			steer: { type: "choice", instructions: STEER_INSTRUCTIONS, criteria: steerCriteria },
		},
	};
}

export function parseSystem1(out: unknown, facts: Facts): Verdict {
	const answers = obj(obj(out).answers);
	const s = obj(answers.state);
	const st = obj(answers.steer);
	const state = STATES.includes(s.choice as WatchState) ? (s.choice as WatchState) : "progressing";
	const probs = obj(s.probabilities);
	const confidence = typeof probs[state] === "number" ? Number(probs[state]) : typeof s.confidence === "number" ? Number(s.confidence) : 0;
	// The steer follows the state. Kev answered the steer question independently of the state question and
	// often disagreed with itself (026: drifting with "verify_item"), so its own steer choice is only logged.
	const steerId = STEER_FOR[state];
	const steerChoice = STEERS.includes(st.choice as SteerId) ? (st.choice as SteerId) : undefined;
	return { state, confidence, steerId, steerChoice, steer: steerLine(steerId, facts), probabilities: probs as Verdict["probabilities"], source: "system1" };
}

export const SYSTEM2_PROMPT = [
	"You watch an autonomous coding agent from outside. You get a digest: computed facts and its last tool calls.",
	"Classify its state right now:",
	"- progressing: changes the files the current item needs, checks move forward, commits, or moves on.",
	"- looping: the same command, read, edit or probe repeats without new information, edits undo each other, or the loop guard keeps firing.",
	"- drifting: time goes to side work the item does not need (throwaway walker/probe scripts, tooling, unrelated polish) while the item's change sits uncommitted or unverified.",
	"- stuck_env: tools fail for reasons outside the code (server down, port in use, missing command, model or network errors, timeouts).",
	"- overclaiming: marks items done, completes the goal or reports success without a passing check of that item after its last edit.",
	"- waiting: waiting on a background job, subagent or long run; nothing wrong yet.",
	'Answer with JSON only: {"state": "<one of the six>", "confidence": <0..1>, "steer": "<one imperative line for the agent, or empty when progressing or waiting>"}',
].join("\n");

export function system2Messages(digest: string): Array<{ role: string; content: string }> {
	return [
		{ role: "system", content: SYSTEM2_PROMPT },
		{ role: "user", content: digest },
	];
}

export const SYSTEM2_SCHEMA = {
	type: "json_schema",
	json_schema: {
		name: "watch_verdict",
		strict: true,
		schema: {
			type: "object",
			properties: { state: { type: "string", enum: [...STATES] }, confidence: { type: "number" }, steer: { type: "string" } },
			required: ["state", "confidence", "steer"],
			additionalProperties: false,
		},
	},
};

export function parseSystem2(content: string): Verdict | undefined {
	const match = /\{[\s\S]*\}/.exec(content ?? "");
	if (!match) return undefined;
	try {
		const parsed = obj(JSON.parse(match[0]));
		const state = String(parsed.state ?? "").trim().toLowerCase().replace(/[-\s]/g, "_") as WatchState;
		if (!STATES.includes(state)) return undefined;
		const c = Number(parsed.confidence);
		return { state, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c > 1 ? c / 100 : c)) : 0, steer: oneLine(String(parsed.steer ?? ""), 240), source: "chat" };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Settings

export interface WatcherConfig {
	mode: WatcherMode;
	api: WatcherApi;
	url: string;
	model: string;
	threshold: number;
	every: number;
	minutes: number;
	timeoutS: number;
	steerGapMin: number;
	log: string;
}

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "omp-strata");

export function readSettings(file = path.join(CONFIG_DIR, "settings.env")): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const m = /^\s*(WATCHER_[A-Z_]+|SIDE_BASE_URL|SIDE_MODEL_ID)\s*=\s*(.*?)\s*$/.exec(line);
			if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
		}
	} catch {
		// No settings file: defaults.
	}
	return out;
}

/** Calibrated on the 026 replay set (train split); see experiments/026-watcher/README.md in the lab. */
export const DEFAULT_THRESHOLD = { chat: 0.9, system1: 0.4, rules: 0.7 } as const;

export function loadConfig(env: Record<string, string | undefined> = process.env, settings: Record<string, string> = readSettings()): WatcherConfig {
	const pick = (envKey: string, setKey: string, fallback: string) => (env[envKey] ?? settings[setKey] ?? fallback).trim();
	const num = (value: string, fallback: number) => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	};
	const modeRaw = pick("OMP_STRATA_WATCHER", "WATCHER_MODE", "log").toLowerCase();
	const apiRaw = pick("OMP_STRATA_WATCHER_API", "WATCHER_API", "chat").toLowerCase();
	const api: WatcherApi = apiRaw === "system1" || apiRaw === "rules" ? apiRaw : "chat";
	return {
		mode: modeRaw === "off" || modeRaw === "steer" ? modeRaw : "log",
		api,
		// With no WATCHER_URL/WATCHER_MODEL, a chat watcher uses the side model apply.sh already configures.
		url: pick("OMP_STRATA_WATCHER_URL", "WATCHER_URL", settings.SIDE_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/+$/, ""),
		model: pick("OMP_STRATA_WATCHER_MODEL", "WATCHER_MODEL", settings.SIDE_MODEL_ID || "side-model"),
		threshold: num(pick("OMP_STRATA_WATCHER_THRESHOLD", "WATCHER_THRESHOLD", ""), DEFAULT_THRESHOLD[api]),
		every: Math.round(num(pick("OMP_STRATA_WATCHER_EVERY", "WATCHER_EVERY", ""), 8)),
		minutes: num(pick("OMP_STRATA_WATCHER_MINUTES", "WATCHER_MINUTES", ""), 10),
		timeoutS: num(pick("OMP_STRATA_WATCHER_TIMEOUT_S", "WATCHER_TIMEOUT_S", ""), 90),
		steerGapMin: num(pick("OMP_STRATA_WATCHER_STEER_GAP_MIN", "WATCHER_STEER_GAP_MIN", ""), 15),
		log: pick("OMP_STRATA_WATCHER_LOG", "WATCHER_LOG", path.join(CONFIG_DIR, "watcher.jsonl")),
	};
}

// ---------------------------------------------------------------------------
// Asking the watcher model

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function askWatcher(cfg: WatcherConfig, digest: string, facts: Facts, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Verdict> {
	const started = Date.now();
	if (cfg.api === "rules") return { ...ruleVerdict(facts), ms: 0 };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutS * 1000);
	(timer as { unref?: () => void }).unref?.();
	try {
		if (cfg.api === "system1") {
			const url = /\/v1$/.test(cfg.url) ? `${cfg.url}/systemone` : `${cfg.url}/v1/systemone`;
			const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(system1Body(digest, facts, hashText(digest) ^ (Date.now() & 0xffff))), signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { ...parseSystem1(await res.json(), facts), ms: Date.now() - started };
		}
		const res = await fetchFn(`${cfg.url}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: cfg.model, messages: system2Messages(digest), temperature: 0, max_tokens: 200, reasoning_effort: "none", response_format: SYSTEM2_SCHEMA }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = obj(await res.json());
		const choice = obj(Array.isArray(body.choices) ? body.choices[0] : undefined);
		const content = String(obj(choice.message).content ?? "");
		const verdict = parseSystem2(content);
		if (!verdict) throw new Error(`unparsable answer: ${oneLine(content, 120)}`);
		return { ...verdict, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// The controller

export const STEER_PREFIX = "Watcher";

export interface Decision {
	steer?: string;
	armGate?: boolean;
	note: string;
}

export class WatchController {
	history: Verdict[] = [];
	lastSteerAt = -Infinity;
	constructor(readonly cfg: Pick<WatcherConfig, "mode" | "threshold" | "steerGapMin">) {}

	/** Decide what to do with a new verdict. Steer only on two consecutive same-state verdicts at or above the threshold. */
	onVerdict(v: Verdict, facts: Facts, now: number): Decision {
		const prev = this.history[this.history.length - 1];
		this.history.push(v);
		if (this.history.length > 20) this.history.shift();
		if (v.state === "progressing" || v.state === "waiting") return { note: v.state };
		const confirmed = !!prev && prev.state === v.state && prev.confidence >= this.cfg.threshold && v.confidence >= this.cfg.threshold;
		// A claim is one event, so the window before it rarely shows it too (026 replay). One overclaiming verdict
		// at or above the threshold arms the done gate, which then demands the item's own evidence; that costs
		// nothing when the claim was real. A steer still needs two verdicts in a row.
		const armGate = v.state === "overclaiming" && v.confidence >= this.cfg.threshold;
		if (!confirmed) {
			const note = v.confidence >= this.cfg.threshold ? "first sighting" : "below threshold";
			if (armGate && this.cfg.mode === "steer") return { note: `${note}; done gate armed`, armGate: true };
			return { note };
		}
		if (v.state === "looping" && facts.guardWindow > 0) return { note: "looping left to the fail-loop guard (it fired in this window)" };
		const decision: Decision = { note: "confirmed", armGate };
		if (this.cfg.mode !== "steer") return { ...decision, armGate: false, note: "confirmed (log mode: no steer)" };
		if (now - this.lastSteerAt < this.cfg.steerGapMin * 60000) return { ...decision, note: "confirmed, rate-limited" };
		const line = v.steer?.trim() || steerLine(v.steerId ?? STEER_FOR[v.state], facts);
		if (!line) return decision;
		this.lastSteerAt = now;
		return { ...decision, steer: `${STEER_PREFIX} (${v.state.replace("_", " ")}, ${Math.round(v.confidence * 100)}%): ${line}` };
	}
}

// ---------------------------------------------------------------------------
// The extension

interface Ctx {
	cwd?: string;
	sessionManager?: { getBranch?: () => readonly BranchEntry[]; getCwd?: () => string };
}

export default function (pi: {
	on(event: "tool_result", handler: (event: unknown, ctx?: Ctx) => void): void;
	on(event: "tool_call", handler: (event: unknown, ctx?: Ctx) => undefined): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
	sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" | "aside"; attribution?: "user" | "agent" }) => void;
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	const cfg = loadConfig();
	if (cfg.mode === "off") return;
	pi.logger?.warn?.("strata watcher loaded", { mode: cfg.mode, api: cfg.api, url: cfg.url, model: cfg.model, threshold: cfg.threshold, every: cfg.every });
	let controller = new WatchController(cfg);
	let ctxRef: Ctx | undefined;
	let results = 0;
	let lastCheckAt = 0;
	let lastCheckResults = 0;
	let lastResultAt = 0;
	let inFlight = false;
	const reset = (_e: unknown, ctx: Ctx) => {
		ctxRef = ctx;
		controller = new WatchController(cfg);
		results = 0;
		lastCheckResults = 0;
	};
	pi.on("session_start", reset);
	pi.on("session_switch", reset);

	const check = (trigger: string) => {
		if (inFlight) return;
		let branch: readonly BranchEntry[] | undefined;
		try {
			branch = ctxRef?.sessionManager?.getBranch?.();
		} catch {
			branch = undefined;
		}
		if (!Array.isArray(branch)) return;
		inFlight = true;
		lastCheckAt = Date.now();
		lastCheckResults = results;
		let digest: ReturnType<typeof buildDigest>;
		try {
			let cwd: string | undefined;
			try {
				cwd = ctxRef?.cwd ?? ctxRef?.sessionManager?.getCwd?.();
			} catch {
				cwd = undefined;
			}
			digest = buildDigest(branch, WINDOW, cwd);
		} catch (error) {
			inFlight = false;
			pi.logger?.warn?.("watcher: digest failed", { error: String(error) });
			return;
		}
		askWatcher(cfg, digest.text, digest.facts)
			.catch(error => {
				pi.logger?.warn?.("watcher: endpoint failed, using rules", { error: String(error).slice(0, 200) });
				return { ...ruleVerdict(digest.facts), source: "rules-fallback" } as Verdict;
			})
			.then(verdict => {
				const now = Date.now();
				// The rule baseline rides along in every row, so the log pairs model and rules (weekly routine).
				const rules = ruleVerdict(digest.facts);
				const decision = controller.onVerdict(verdict, digest.facts, now);
				if (decision.armGate) armDoneGate(digest.facts.item, `${verdict.state} ${verdict.confidence.toFixed(2)}`, 30, now);
				if (decision.steer) pi.sendUserMessage?.(decision.steer, { deliverAs: "steer", attribution: "agent" });
				const fields = { state: verdict.state, confidence: Math.round(verdict.confidence * 100) / 100, source: verdict.source, ms: verdict.ms, decision: decision.note, steered: !!decision.steer, item: digest.facts.item?.slice(0, 60) };
				pi.logger?.warn?.("watcher: verdict", fields);
				try {
					mkdirSync(path.dirname(cfg.log), { recursive: true });
					appendFileSync(cfg.log, `${JSON.stringify({ at: new Date(now).toISOString(), trigger, calls: digest.calls, mode: cfg.mode, api: cfg.api, model: cfg.api === "chat" ? cfg.model : cfg.api, verdict: { ...verdict, raw: undefined }, rules: verdict.source.startsWith("rules") ? undefined : { state: rules.state, confidence: rules.confidence }, decision: decision.note, steer: decision.steer, facts: digest.facts, digest: digest.text })}\n`);
				} catch {
					// Logging must never disturb the run.
				}
			})
			.finally(() => {
				inFlight = false;
			});
	};

	pi.on("tool_call", (_event, ctx) => {
		if (ctx?.sessionManager) ctxRef = ctx;
		return undefined;
	});
	pi.on("tool_result", (_event, ctx) => {
		if (ctx?.sessionManager) ctxRef = ctx;
		results++;
		const now = Date.now();
		const active = now - lastResultAt < cfg.minutes * 60000;
		lastResultAt = now;
		if (results - lastCheckResults >= cfg.every) check("calls");
		else if (active && lastCheckAt && now - lastCheckAt >= cfg.minutes * 60000 && results > lastCheckResults) check("minutes");
		else if (!lastCheckAt && results >= cfg.every) check("calls");
	});
}
