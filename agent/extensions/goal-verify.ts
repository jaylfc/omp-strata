/**
 * Verify before goal complete.
 *
 * The first `goal({op: "complete"})` of each goal is refused with a short
 * verification checklist and the goal's objective: list each acceptance
 * criterion and run each through verify_item (done-gate.ts), which executes
 * the probe and reports its exit code. The refusal is the injected turn: the
 * model reads it as the goal call's result and keeps working in the same run.
 *
 * The verdict comes from exit codes, not from the model's reading of them.
 * The next `goal complete` goes through when, since the checklist, at least
 * one verify_item ran (a heuristic probe counts as a fallback), the latest
 * run of every criterion exited 0, and no reply has a FAIL line. Otherwise it
 * is refused with the failing criteria, and the next attempt needs a new run.
 * After 3 refusals for one goal the call goes through and logs
 * `goal-verify: overridden`, so it never holds a goal.
 *
 * The verifier's probes run outside the coder (the extension runs them), but
 * the checklist round runs in the main session. omp 18.6.1 offers no
 * probe-running fresh context to an extension: runEphemeralTurn is one reply
 * on the session's own model with no tools, and task subagents are pinned to
 * the side model with the coder as fallback. That is deferred.
 *
 * `/goal complete` typed by the operator does not pass through tools and is
 * not checked.
 *
 * OMP_STRATA_GOAL_VERIFY: on (default), log, off.
 */
import { type BranchEntry, classifyResult, envMode, isProbeCommand, textOf, type ToolResult, type Verification, verificationOf } from "./done-gate.ts";

export const VERIFY_MARKER = `<system-interrupt reason="goal_verify">`;
export const MAX_REFUSALS = 3;
const OBJECTIVE_MAX = 2000;

export interface VerifyState {
	clock: number;
	goalId?: string;
	objective?: string;
	requestedAt?: number;
	refusals: number;
	verified: boolean;
	probes: number[];
	replies: Array<{ at: number; text: string }>;
	verifications: Verification[];
}

export function newVerifyState(): VerifyState {
	return { clock: 0, refusals: 0, verified: false, probes: [], replies: [], verifications: [] };
}

function tick(state: VerifyState, at: number): number {
	state.clock = Math.max(state.clock + 1, at);
	return state.clock;
}

/** A new goal resets the round. */
export function setGoal(state: VerifyState, id: string | undefined, objective: string | undefined): void {
	if (id && id !== state.goalId) {
		state.goalId = id;
		state.requestedAt = undefined;
		state.refusals = 0;
		state.verified = false;
	}
	if (objective) state.objective = objective;
}

function goalFrom(value: unknown): { id?: string; objective?: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const goal = (value as { goal?: { id?: unknown; objective?: unknown } }).goal;
	if (!goal || typeof goal !== "object") return undefined;
	return { id: typeof goal.id === "string" ? goal.id : undefined, objective: typeof goal.objective === "string" ? goal.objective : undefined };
}

export function recordResult(state: VerifyState, result: ToolResult, at: number): void {
	const now = tick(state, at);
	if (result.toolName === "goal") {
		const goal = goalFrom(result.details);
		if (goal) setGoal(state, goal.id, goal.objective);
		return;
	}
	const verified = verificationOf(result);
	if (verified) {
		state.verifications.push({ ...verified, at: now });
		return;
	}
	if (classifyResult(result)) state.probes.push(now);
}

export function recordReply(state: VerifyState, text: string, at: number): void {
	if (text.trim()) state.replies.push({ at: tick(state, at), text });
}

/** Lines that report a failed criterion: "FAIL" as a word, without "PASS" on the same line. */
export function failLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => /\bFAIL(?:ED|S)?\b/.test(line) && !/\bPASS(?:ED|ES)?\b/.test(line))
		.map(line => (line.length > 160 ? `${line.slice(0, 159)}…` : line));
}

function asyncProbeTimes(branch: readonly BranchEntry[] | undefined, since: number): number[] {
	if (!Array.isArray(branch)) return [];
	const out: number[] = [];
	for (const entry of branch) {
		if (entry?.type !== "custom_message" || entry.customType !== "async-result") continue;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number(entry.timestamp);
		if (!(at > since)) continue;
		const text = textOf(entry.content);
		const inline = [...text.matchAll(/── Job \S+ \((.*)\) ──/g)].map(m => m[1]);
		if (inline.length === 0 || inline.some(isProbeCommand)) out.push(at);
	}
	return out;
}

export function checklist(objective: string | undefined): string {
	const goal = objective ? (objective.length > OBJECTIVE_MAX ? `${objective.slice(0, OBJECTIVE_MAX)}…` : objective) : "(not available; read it with goal({op: \"get\"}))";
	return [
		VERIFY_MARKER,
		"The goal is not complete yet. Verify it first, in one round:",
		"1. List each acceptance criterion in the objective below, one per line.",
		'2. For each one, run a probe through verify_item: write to xd://verify_item with content {"task": "<criterion>", "command": "<probe>"}. The probe must exercise the criterion the way a user would: real requests or real play with default inputs, the exact screen the criterion names, and one edge case (malformed input, repeated or long use). It must exit non-zero when the criterion fails. A syntax check, a best-case simulator, or a screenshot of a different screen is not evidence.',
		'3. Reply with one line per criterion: "PASS <criterion>" or "FAIL <criterion>: <what you saw>".',
		"The goal completes only when the latest verify_item of every criterion exited 0. Any failure keeps it active: fix it, run verify_item again, then call goal complete.",
		`<objective>\n${goal}\n</objective>`,
		"</system-interrupt>",
	].join("\n");
}

export function failReason(failed: Verification[], lines: string[]): string {
	return [
		VERIFY_MARKER,
		"The goal stays active.",
		...failed.slice(0, 8).map(v => `- verify_item exit ${v.exit < 0 ? "timeout" : v.exit}: ${JSON.stringify(v.task.slice(0, 100))} (${v.command.slice(0, 80)})`),
		...lines.slice(0, 8).map(line => `- you reported: ${line}`),
		"Fix these, run verify_item for each again, then call goal complete.",
		"</system-interrupt>",
	].join("\n");
}

export function noProbeReason(): string {
	return [
		VERIFY_MARKER,
		'No verify_item has run since the verification request. For each acceptance criterion write to xd://verify_item with content {"task": "<criterion>", "command": "<probe>"}, then call goal complete.',
		"</system-interrupt>",
	].join("\n");
}

export interface VerifyDecision {
	block?: boolean;
	reason?: string;
	log: { message: string; fields: Record<string, unknown> };
}

/** Decide on a goal complete call. `now` is the call time. */
export function decideComplete(state: VerifyState, mode: "on" | "log", now: number, branch?: readonly BranchEntry[]): VerifyDecision {
	const fields: Record<string, unknown> = { goal: state.goalId, mode, refusals: state.refusals };
	const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}): VerifyDecision => {
		if (mode === "log") return { log: { message: `goal-verify: would refuse (${message})`, fields: { ...fields, ...extra } } };
		if (state.refusals >= MAX_REFUSALS) return { log: { message: "goal-verify: overridden", fields: { ...fields, ...extra, reason: message } } };
		state.refusals++;
		return { block: true, reason, log: { message: `goal-verify: refused (${message})`, fields: { ...fields, ...extra, refusals: state.refusals } } };
	};
	if (state.verified) return { log: { message: "goal-verify: already verified", fields } };
	if (state.requestedAt === undefined) {
		const at = tick(state, now);
		const decision = refuse(checklist(state.objective), "verification requested");
		if (decision.block || mode === "log") state.requestedAt = at;
		return decision;
	}
	const since = state.requestedAt;
	const latest = new Map<string, Verification>();
	for (const v of state.verifications) if (v.at > since) latest.set(v.task.trim().toLowerCase(), v);
	const runs = [...latest.values()];
	const failed = runs.filter(v => v.exit !== 0);
	const probes = state.probes.filter(t => t > since).length + asyncProbeTimes(branch, since).length;
	// Replies older than the newest run describe code that has since been probed again; exit codes speak for them.
	const lastRun = Math.max(since, ...runs.map(v => v.at), ...state.probes.filter(t => t > since));
	const report = state.replies.filter(r => r.at > lastRun).map(r => r.text).join("\n");
	const fails = failLines(report);
	const counts = { verified: runs.length - failed.length, failedRuns: failed.length, probes, fails: fails.length, passLines: (report.match(/\bPASS\b/g) ?? []).length };
	if (runs.length === 0 && probes === 0) return refuse(noProbeReason(), "no probe since the request", counts);
	if (failed.length > 0 || fails.length > 0) {
		const decision = refuse(failReason(failed, fails), failed.length ? "verify_item failed" : "FAIL reported", counts);
		if (decision.block) state.requestedAt = tick(state, now);
		return decision;
	}
	state.verified = true;
	return { log: { message: "goal-verify: verified", fields: { ...fields, ...counts, byExitCode: runs.length > 0 } } };
}

/** Rebuild from the session: the active goal, an earlier checklist, probes and replies since. */
export function seedFromBranch(state: VerifyState, branch: readonly BranchEntry[]): void {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const raw = entry?.message?.timestamp ?? entry?.timestamp;
		const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
		const when = Number.isNaN(at) ? state.clock + 1 : at;
		const e = entry as BranchEntry & { mode?: string; data?: unknown };
		if (e?.type === "mode_change") {
			const goal = goalFrom(e.data);
			if (goal) setGoal(state, goal.id, goal.objective);
			continue;
		}
		if (e?.type === "custom" && e.customType === "goal-completed") {
			state.verified = true;
			continue;
		}
		const message = entry?.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const text: string[] = [];
			for (const block of message.content) {
				const b = block as { type?: string; id?: string; name?: string; arguments?: unknown; text?: string };
				if (b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") calls.set(b.id, { name: b.name, args: b.arguments });
				if (b?.type === "text" && typeof b.text === "string") text.push(b.text);
			}
			recordReply(state, text.join("\n"), when);
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			const name = call?.name ?? message.toolName ?? "";
			const body = textOf(message.content);
			if (name === "goal" && body.includes(VERIFY_MARKER)) {
				state.refusals++;
				if (state.requestedAt === undefined || body.includes("reported FAIL")) state.requestedAt = tick(state, when);
				continue;
			}
			recordResult(state, { toolName: name, input: call?.args ?? {}, isError: message.isError === true, content: message.content, details: message.details }, when);
		}
	}
}

type Logger = { warn?: (message: string, fields?: Record<string, unknown>) => void };
interface Ctx {
	sessionManager?: { getBranch?: () => readonly BranchEntry[] };
}

function branchOf(ctx: Ctx | undefined): readonly BranchEntry[] | undefined {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: {
	on(event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx?: Ctx) => { block?: boolean; reason?: string } | undefined): void;
	on(event: "tool_result", handler: (event: ToolResult, ctx?: Ctx) => void): void;
	on(event: "assistant_message", handler: (event: { message?: { content?: unknown } }) => undefined): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
	logger?: Logger;
}): void {
	const mode = envMode("OMP_STRATA_GOAL_VERIFY", "on");
	if (mode === "off") return;
	let state = newVerifyState();
	const reseed = (_event: unknown, ctx: Ctx): void => {
		state = newVerifyState();
		const branch = branchOf(ctx);
		if (!branch) return;
		try {
			seedFromBranch(state, branch);
		} catch {
			state = newVerifyState();
		}
	};
	pi.logger?.warn?.("strata goal-verify loaded", { mode });
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);
	pi.on("assistant_message", event => {
		recordReply(state, textOf(event?.message?.content), Date.now());
		return undefined;
	});
	pi.on("tool_result", event => {
		if (event.toolName === "goal" && textOf(event.content).includes(VERIFY_MARKER)) return;
		recordResult(state, event, Date.now());
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "goal") return undefined;
		const op = (event.input as { op?: unknown } | undefined)?.op;
		const branch = branchOf(ctx);
		if (op === "create" || op === "resume") return undefined;
		if (op !== "complete") return undefined;
		if (branch) {
			// The active goal, in case it started after the last seed.
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i] as BranchEntry & { data?: unknown };
				if (e?.type !== "mode_change") continue;
				const goal = goalFrom(e.data);
				if (goal?.id) {
					setGoal(state, goal.id, goal.objective);
					break;
				}
			}
		}
		const decision = decideComplete(state, mode === "log" ? "log" : "on", Date.now(), branch);
		pi.logger?.warn?.(decision.log.message, decision.log.fields);
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	});
}
