/**
 * Local Strata guard for omp 18.4.4.
 *
 * Blocks the next identical call after the same arguments have been used 3
 * times, whether those calls failed or succeeded. Refuses eval code that
 * calls completion(), which would send that request to the coder. judge()
 * is allowed: point modelRoles.judge at the side model.
 *
 * SIDE_MODEL pins every subagent (the task tool and eval agent()) to a
 * second model so the spawn does not take the coder's only request slot.
 * Set it to "" to refuse subagents instead. The provider id and model id
 * must exist in models.yml. Remove the fail-loop half once an omp build
 * includes the failure block from PR 14312.
 *
 * wait, job, irc, yield, todo, and goal are allowed to repeat.
 */
const BLOCK_AFTER = 3;
/** Empty string refuses subagents. A selector pins them to that model. */
const SIDE_MODEL = "mac/prism-ml/bonsai-27b";
const EXEMPT = new Set(["wait", "job", "irc", "yield", "todo", "goal"]);
const INTENT_KEYS = new Set(["i", "__intent"]);

interface FailureReport {
	toolName: string;
	argumentsSummary: string;
	resultSummary: string;
}

interface ToolCallShape {
	toolName: string;
	input: unknown;
}

interface ToolResultShape extends ToolCallShape {
	isError: boolean;
	content: Array<{ type?: string; text?: string }>;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => canonicalize(item));
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (INTENT_KEYS.has(key)) continue;
		output[key] = canonicalize(input[key]);
	}
	return output;
}

function signature(toolName: string, args: unknown): string {
	return JSON.stringify([toolName, canonicalize(args)]);
}

function summarize(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) summary = `${summary.slice(0, limit)}…`;
	return summary;
}

function resultText(content: ToolResultShape["content"] | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.join("\n");
}

function reportFor(toolName: string, args: unknown, text: string): FailureReport {
	return {
		toolName,
		argumentsSummary: summarize(JSON.stringify(canonicalize(args)), 400),
		resultSummary: summarize(text, 200),
	};
}

interface SessionEntry {
	message?: {
		role?: string;
		content?: unknown;
		isError?: boolean;
		toolCallId?: string;
		toolName?: string;
	};
}

/** The trailing run of one identical call, whatever its results were. */
export interface Run {
	signature: string;
	count: number;
	allFailed: boolean;
	allSucceeded: boolean;
	/** Oldest failure in the run, for the fail message. */
	firstFailure?: FailureReport;
	/** Newest result in the run. */
	last: FailureReport;
}

const OWN_MARKERS = [
	`<system-interrupt reason="tool_call_loop_blocked">`,
	`<system-interrupt reason="completion_uses_coder">`,
	`<system-interrupt reason="describe_mjs_blocked">`,
	`<system-interrupt reason="probe_repeat_blocked">`,
];

/**
 * A result that is one of this extension's own refusals is not a real run of
 * the call. omp may wrap the refusal text, so the marker can sit anywhere.
 */
function isOwnBlock(text: string): boolean {
	return OWN_MARKERS.some(marker => text.includes(marker));
}

/** Extend run with one newer result, or start a new run when the call differs. */
function extendRun(run: Run | undefined, next: string, isError: boolean, report: FailureReport): Run {
	if (run && run.signature === next) {
		return {
			signature: next,
			count: run.count + 1,
			allFailed: run.allFailed && isError,
			allSucceeded: run.allSucceeded && !isError,
			firstFailure: run.firstFailure ?? (isError ? report : undefined),
			last: report,
		};
	}
	return {
		signature: next,
		count: 1,
		allFailed: isError,
		allSucceeded: !isError,
		firstFailure: isError ? report : undefined,
		last: report,
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return resultText(content as ToolResultShape["content"]);
}

/** Rebuild the trailing run of one identical call already stored in the session. */
export function seedFromBranch(branch: readonly SessionEntry[]): Run | undefined {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const message = entry?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
			calls.set(call.id, { name: call.name, args: call.arguments });
		}
	}

	// Find where the trailing run starts, then replay it oldest first.
	const results: Array<{ name: string; args: unknown; isError: boolean; text: string }> = [];
	let runSignature: string | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const message = branch[index]?.message;
		if (!message || message.role !== "toolResult") continue;
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = call?.name ?? message.toolName ?? "";
		if (!name || EXEMPT.has(name)) continue;
		const text = textOf(message.content);
		if (isOwnBlock(text)) continue;
		const args = call?.args ?? {};
		const next = signature(name, args);
		if (runSignature === undefined) runSignature = next;
		else if (next !== runSignature) break;
		results.push({ name, args, isError: message.isError === true, text });
	}

	let run: Run | undefined;
	for (const result of results.reverse()) {
		const next = signature(result.name, result.args);
		run = extendRun(run, next, result.isError, reportFor(result.name, result.args, result.text));
	}
	return run;
}

function failReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call failed ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`First failure in this streak (truncated): \`${result}\``,
		"",
		"Read that failure and determine why this call failed before you choose the next action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again. Continue the current goal with different arguments, a different command, or a different tool.`,
		`</system-interrupt>`,
	].join("\n");
}

function successReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call already succeeded ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`Result (truncated): \`${result}\``,
		"",
		"Read that result and continue the current goal with a different action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again.`,
		`</system-interrupt>`,
	].join("\n");
}

function repeatReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call already ran ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`Last result (truncated): \`${result}\``,
		"",
		"Read that result and continue the current goal with a different action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again.`,
		`</system-interrupt>`,
	].join("\n");
}

function codeOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const code = (input as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

function callsCompletion(input: unknown): boolean {
	return /\bcompletion\s*\(/.test(codeOf(input));
}

const PROBE_RE = /(?:where|touchprobe|menutest|doorwalk|firstsnap|battletest|smoke|xcheck)\.mjs/;

function commandText(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const record = input as { command?: unknown; code?: unknown };
	if (typeof record.command === "string") return record.command;
	if (typeof record.code === "string") return record.code;
	return "";
}

function probeKey(input: unknown): string | undefined {
	const text = commandText(input);
	if (/describe\.mjs/.test(text)) return "describe.mjs";
	const match = text.match(PROBE_RE);
	return match ? match[0] : undefined;
}

function describeReason(): string {
	return [
		`<system-interrupt reason="describe_mjs_blocked">`,
		"describe.mjs was not run. It calls the side model from this turn and can spend the whole reply on thinking.",
		"",
		"For a saved screenshot, read <path>?q=<question>. For a pass/fail check, call judge() once in eval. Both use the Mac mini.",
		"",
		"Continue the current goal with that call.",
		`</system-interrupt>`,
	].join("\n");
}

function probeReason(script: string, count: number): string {
	return [
		`<system-interrupt reason="probe_repeat_blocked">`,
		`${script} already ran ${count} times since the last edit. Another probe will not teach you more.`,
		"",
		"Use the numbers you have. After a screenshot, read <path>?q=<question> or call judge() once. Those run on the Mac mini.",
		"",
		"Continue the current goal with a different action. Edit the code before probing again.",
		`</system-interrupt>`,
	].join("\n");
}

function completionReason(): string {
	return [
		`<system-interrupt reason="completion_uses_coder">`,
		"completion() was not run. It sends another request to the coder and replaces the prompt cache.",
		"",
		"Use judge() when a judge model is configured. For a saved image, read <path>?q=<question>. Read game state as numbers or text from the page, or run cinderline/tools/where.mjs, touchprobe.mjs, or menutest.mjs once and use that result.",
		"",
		"Continue the current goal with a different action.",
		`</system-interrupt>`,
	].join("\n");
}

function taskReason(): string {
	if (SIDE_MODEL) {
		return [
			`<system-interrupt reason="subagent_pinned">`,
			`Subagents run on \`${SIDE_MODEL}\` so the coder keeps its prompt cache.`,
			"",
			"Continue the current goal. Use the task tool for side work and do not pin that work to the coder.",
			`</system-interrupt>`,
		].join("\n");
	}
	return [
		`<system-interrupt reason="local_model_single_request">`,
		"The task tool was not run. This session uses one local model that serves one request at a time, and a subagent replaces the prompt the goal is in the middle of.",
		"",
		"Do the work inline in this session. Continue the current goal with the tools you already have.",
		`</system-interrupt>`,
	].join("\n");
}

interface SessionContext {
	sessionManager?: { getBranch?: () => readonly SessionEntry[] };
}

export default function (pi: {
	on(event: "tool_call", handler: (event: ToolCallShape) => { block?: boolean; reason?: string } | undefined): void;
	on(event: "tool_result", handler: (event: ToolResultShape) => void): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: SessionContext) => void): void;
	on(
		event: "before_subagent_spawn",
		handler: (event: { agent?: string; patterns?: string[] }) => { block?: boolean; reason?: string; model?: string; note?: string } | undefined,
	): void;
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	let run: Run | undefined;
	let probeSeen: string | undefined;
	let probeCount = 0;

	const reseed = (_event: unknown, ctx: SessionContext): void => {
		run = undefined;
		probeSeen = undefined;
		probeCount = 0;
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) run = seedFromBranch(branch);
		} catch {
			// A session that cannot be read still counts new calls from zero.
		}
	};
	pi.logger?.warn?.("strata resteer loaded", {
		blockAfter: BLOCK_AFTER,
		completionBlocked: true,
		sideModel: SIDE_MODEL || "blocked",
	});
	pi.on("before_subagent_spawn", () => {
		if (!SIDE_MODEL) {
			pi.logger?.warn?.("blocking subagent with no side model");
			return { block: true, reason: taskReason() };
		}
		return {
			model: SIDE_MODEL,
			note: `Subagent pinned to ${SIDE_MODEL} so the coder keeps its prompt cache.`,
		};
	});
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", event => {
		if (event.toolName === "edit" || event.toolName === "write") {
			probeSeen = undefined;
			probeCount = 0;
		}
		const probed = probeKey(event.input);
		if (probed && probed !== "describe.mjs") {
			if (probed === probeSeen) probeCount++;
			else {
				probeSeen = probed;
				probeCount = 1;
			}
		}
		if (EXEMPT.has(event.toolName)) return;
		const text = resultText(event.content);
		if (isOwnBlock(text)) return;
		const next = signature(event.toolName, event.input);
		run = extendRun(run, next, event.isError, reportFor(event.toolName, event.input, text));
	});

	pi.on("tool_call", event => {
		if (event.toolName === "task" && !SIDE_MODEL) {
			pi.logger?.warn?.("blocking subagent task on local model", { toolName: event.toolName });
			return { block: true, reason: taskReason() };
		}
		if (EXEMPT.has(event.toolName)) return;
		if (event.toolName === "eval" && callsCompletion(event.input)) {
			pi.logger?.warn?.("blocking completion() on the coder", { toolName: event.toolName });
			return { block: true, reason: completionReason() };
		}
		const probed = probeKey(event.input);
		if (probed === "describe.mjs") {
			pi.logger?.warn?.("blocking describe.mjs", { toolName: event.toolName });
			return { block: true, reason: describeReason() };
		}
		if (probed && probed === probeSeen && probeCount >= BLOCK_AFTER) {
			pi.logger?.warn?.("blocking repeated probe", { toolName: event.toolName, script: probed, count: probeCount });
			return { block: true, reason: probeReason(probed, probeCount) };
		}
		const next = signature(event.toolName, event.input);
		if (run && run.count >= BLOCK_AFTER && next === run.signature) {
			pi.logger?.warn?.("blocking repeated tool call", { toolName: event.toolName, count: run.count });
			if (run.allFailed && run.firstFailure) return { block: true, reason: failReason(run.firstFailure, run.count) };
			if (run.allSucceeded) return { block: true, reason: successReason(run.last, run.count) };
			return { block: true, reason: repeatReason(run.last, run.count) };
		}
	});
}
