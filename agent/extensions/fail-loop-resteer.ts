/**
 * Local Strata guard for omp 18.4.4.
 *
 * Blocks the next identical call after the same arguments have been used 3
 * times, whether those calls failed or succeeded. Also refuses the task tool,
 * which would put a second request on the only local server, and refuses
 * eval code that calls judge(): this profile has no judge model and cannot
 * see images. Remove the fail-loop half once an omp build includes
 * model.toolCallLoopGuard.blockThreshold.
 *
 * wait, job, irc, yield, todo, and goal are allowed to repeat.
 */
const BLOCK_AFTER = 3;
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

export interface SeededRun {
	kind: "fail" | "success";
	count: number;
	signature: string;
	report: FailureReport;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return resultText(content as ToolResultShape["content"]);
}

/** Count the trailing run of one identical call already stored in the session. */
export function seedFromBranch(branch: readonly SessionEntry[]): SeededRun | undefined {
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

	let count = 0;
	let runSignature: string | undefined;
	let kind: SeededRun["kind"] | undefined;
	let report: FailureReport | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const message = branch[index]?.message;
		if (!message || message.role !== "toolResult") continue;
		const toolName = message.toolName ?? "";
		if (EXEMPT.has(toolName)) continue;
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = call?.name ?? toolName;
		if (!name || EXEMPT.has(name)) continue;
		const nextKind: SeededRun["kind"] = message.isError === true ? "fail" : "success";
		const args = call?.args ?? {};
		const next = signature(name, args);
		if (runSignature === undefined) {
			runSignature = next;
			kind = nextKind;
			count = 1;
			report = reportFor(name, args, textOf(message.content));
			continue;
		}
		if (next !== runSignature || nextKind !== kind) break;
		count++;
		if (kind === "fail") report = reportFor(name, args, textOf(message.content));
	}
	if (!runSignature || !report || !kind || count < 1) return undefined;
	return { kind, count, signature: runSignature, report };
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

function callsJudge(input: unknown): boolean {
	return /\b(judge|judgeBatch|judge_batch|completion)\s*\(/.test(codeOf(input));
}

function judgeReason(): string {
	return [
		`<system-interrupt reason="no_judge_model">`,
		"judge() was not run. This session has no judge model, and the coder model cannot see images.",
		"",
		"Do not call judge, completion, or screenshot classification. Read game state as numbers or text from the page, or run cinderline/tools/where.mjs, touchprobe.mjs, or menutest.mjs once and use that result.",
		"",
		"Continue the current goal with a different action.",
		`</system-interrupt>`,
	].join("\n");
}

function taskReason(): string {
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
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	let failCount = 0;
	let failSignature: string | undefined;
	let failReport: FailureReport | undefined;
	let successCount = 0;
	let successSignature: string | undefined;
	let successReport: FailureReport | undefined;
	let repeatCount = 0;
	let repeatSignature: string | undefined;
	let repeatReport: FailureReport | undefined;

	const clearFail = (): void => {
		failCount = 0;
		failSignature = undefined;
		failReport = undefined;
	};
	const clearSuccess = (): void => {
		successCount = 0;
		successSignature = undefined;
		successReport = undefined;
	};

	const reseed = (_event: unknown, ctx: SessionContext): void => {
		clearFail();
		clearSuccess();
		repeatCount = 0;
		repeatSignature = undefined;
		repeatReport = undefined;
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			const seeded = seedFromBranch(branch);
			if (!seeded) return;
			repeatCount = seeded.count;
			repeatSignature = seeded.signature;
			repeatReport = seeded.report;
			if (seeded.kind === "fail") {
				failCount = seeded.count;
				failSignature = seeded.signature;
				failReport = seeded.report;
				return;
			}
			successCount = seeded.count;
			successSignature = seeded.signature;
			successReport = seeded.report;
		} catch {
			// A session that cannot be read still counts new calls from zero.
		}
	};
	pi.logger?.warn?.("strata resteer loaded", { blockAfter: BLOCK_AFTER });
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", event => {
		if (EXEMPT.has(event.toolName)) return;
		const next = signature(event.toolName, event.input);
		const report = reportFor(event.toolName, event.input, resultText(event.content));
		if (next === repeatSignature && repeatCount > 0) {
			repeatCount++;
		} else {
			repeatCount = 1;
			repeatSignature = next;
		}
		repeatReport = report;
		if (!event.isError) {
			clearFail();
			if (next === successSignature && successCount > 0) {
				successCount++;
				successReport = report;
				return;
			}
			successCount = 1;
			successSignature = next;
			successReport = report;
			return;
		}
		clearSuccess();
		if (next === failSignature && failCount > 0) {
			failCount++;
			return;
		}
		failCount = 1;
		failSignature = next;
		failReport = report;
	});

	pi.on("tool_call", event => {
		if (event.toolName === "task") {
			pi.logger?.warn?.("blocking subagent task on local model", { toolName: event.toolName });
			return { block: true, reason: taskReason() };
		}
		if (EXEMPT.has(event.toolName)) return;
		if (event.toolName === "eval" && callsJudge(event.input)) {
			pi.logger?.warn?.("blocking judge() with no judge model", { toolName: event.toolName });
			return { block: true, reason: judgeReason() };
		}
		const next = signature(event.toolName, event.input);
		if (repeatCount >= BLOCK_AFTER && repeatReport && next === repeatSignature) {
			pi.logger?.warn?.("blocking repeated tool call", { toolName: event.toolName, count: repeatCount });
			if (failCount >= BLOCK_AFTER && failReport && next === failSignature) {
				return { block: true, reason: failReason(failReport, failCount) };
			}
			if (successCount >= BLOCK_AFTER && successReport && next === successSignature) {
				return { block: true, reason: successReason(successReport, successCount) };
			}
			return { block: true, reason: repeatReason(repeatReport, repeatCount) };
		}
	});
}
