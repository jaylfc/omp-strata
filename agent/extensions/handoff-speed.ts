/**
 * Faster automatic handoffs on a one-slot, one-prefix server (Strata).
 *
 * omp's auto compaction runs `shake` first. Shake rewrites older tool results
 * in the session (elides them) before it decides whether that was enough.
 * At the 98304-token threshold it usually is not, so the handoff runs next,
 * built from the history shake just rewrote. The server's cached prefix stops
 * at the first elided result, so the handoff request read 47K-83K tokens cold
 * (50-82 s) where an untouched history reuses all but the last 1-3K.
 *
 * This extension watches `before_provider_request`:
 * - Each main-turn request (one with tools that is not a handoff) is
 *   remembered as sent.
 * - On a handoff request it puts back the messages exactly as the last main
 *   turn sent them, and keeps the handoff's own later messages (the newest
 *   reply, its tool results, and the handoff instruction). It only does this
 *   when every remembered message lines up with the handoff's message at the
 *   same position (same role, same tool call ids); otherwise the request goes
 *   out unchanged.
 * - It appends a length limit to the handoff instruction, because decoding
 *   the 13-21K-character documents took 4-8 minutes at 12-14 tok/s.
 * - It caps the handoff's thinking budget (Strata's reasoning_budget_tokens);
 *   reasoning_effort stays as it is, because it is part of the rendered
 *   system prompt and changing it would make the whole request cold.
 *
 * OMP_STRATA_HANDOFF_SPEED=off disables all of it; =prefix keeps only the
 * prefix restore.
 *
 * Constraint pinning (OMP_STRATA_PIN=on, default; off disables). Compaction
 * replaces the history with a summary, and a summary can drop the goal's
 * wording, the item in progress, or a rule. After each compaction
 * (`session_compact`) this extension adds one hidden note with the goal
 * objective verbatim (up to 1,500 characters), the todo item in progress and
 * the open count, and RULES.md verbatim when the system prompt does not
 * already carry it (omp re-sends RULES.md in the system prompt, which
 * compaction does not touch). It arrives as a steer when the run is going,
 * otherwise as a message before the next turn. The request after a
 * compaction reads cold anyway, so the note costs no cache.
 */
import fs from "node:fs";
import nodePath from "node:path";

export const HANDOFF_MARKER = "Write a handoff document for another instance of yourself";
export const LENGTH_MARKER = "<handoff-length>";
export const HANDOFF_MAX_CHARS = 8000;
export const HANDOFF_THINKING_BUDGET = 1024;

export const LENGTH_INSTRUCTION = [
	LENGTH_MARKER,
	`Keep the whole document under ${HANDOFF_MAX_CHARS.toLocaleString("en-US")} characters.`,
	"The most recent part of this conversation stays verbatim after the document, so do not restate it.",
	"Keep in full: Goal (paths, commands, ports), In Progress, Pending, Next Steps, and every decision, constraint, and error text still in force.",
	"Compress Done to one line per item: what changed, which files, and the commit hash.",
	"Leave out tool output, probe transcripts, and numbers the next step does not need.",
	"</handoff-length>",
].join("\n");

type Message = { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string }> };
type Payload = { model?: string; messages?: Message[]; tools?: unknown[]; reasoning_budget_tokens?: number; [key: string]: unknown };

export function messageText(message: Message | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}

export function isHandoffPayload(payload: Payload | undefined): boolean {
	const messages = payload?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return false;
	const last = messages[messages.length - 1];
	return last?.role === "user" && messageText(last).includes(HANDOFF_MARKER);
}

/** A request worth remembering: a normal turn, with tools, that is not a handoff. */
export function isMainTurnPayload(payload: Payload | undefined): boolean {
	return !!payload && Array.isArray(payload.messages) && payload.messages.length >= 2 && Array.isArray(payload.tools) && payload.tools.length > 0 && !isHandoffPayload(payload);
}

function toolCallIds(message: Message): string {
	return Array.isArray(message.tool_calls) ? message.tool_calls.map(call => call?.id ?? "").join(",") : "";
}

/** True when `sent[i]` and `now[i]` are the same message, possibly with different content. */
export function sameSlot(sent: Message, now: Message): boolean {
	if (!sent || !now || sent.role !== now.role) return false;
	if ((sent.tool_call_id ?? "") !== (now.tool_call_id ?? "")) return false;
	return toolCallIds(sent) === toolCallIds(now);
}

/**
 * The handoff's messages with the first `sent.length` replaced by `sent`, or undefined when they do not line up.
 * `changed` counts the positions whose content differed (what shake had rewritten).
 */
export function restorePrefix(sent: Message[], handoff: Message[]): { messages: Message[]; changed: number } | undefined {
	// The handoff adds at least its instruction after the last sent message.
	if (sent.length === 0 || sent.length >= handoff.length) return undefined;
	let changed = 0;
	for (let i = 0; i < sent.length; i++) {
		if (!sameSlot(sent[i], handoff[i])) return undefined;
		if (JSON.stringify(sent[i]) !== JSON.stringify(handoff[i])) changed++;
	}
	return { messages: [...sent, ...handoff.slice(sent.length)], changed };
}

export function appendLengthLimit(message: Message): Message {
	if (messageText(message).includes(LENGTH_MARKER)) return message;
	const content = message.content;
	if (typeof content === "string") return { ...message, content: `${content}\n\n${LENGTH_INSTRUCTION}` };
	if (Array.isArray(content)) return { ...message, content: [...content, { type: "text", text: `\n\n${LENGTH_INSTRUCTION}` }] };
	return message;
}

export function mode(): "on" | "prefix" | "off" {
	const value = (process.env.OMP_STRATA_HANDOFF_SPEED ?? "on").trim().toLowerCase();
	return value === "off" || value === "prefix" ? value : "on";
}

type Logger = { warn?: (message: string, fields?: Record<string, unknown>) => void };

export function createHandler(logger?: Logger, getMode: () => "on" | "prefix" | "off" = mode) {
	let lastMain: { model?: string; messages: Message[] } | undefined;
	return (payload: Payload | undefined): Payload | undefined => {
		const current = getMode();
		if (current === "off" || !payload || !Array.isArray(payload.messages)) return undefined;
		if (!isHandoffPayload(payload)) {
			if (isMainTurnPayload(payload)) lastMain = { model: payload.model, messages: payload.messages.slice() };
			return undefined;
		}
		let messages = payload.messages;
		const fields: Record<string, unknown> = { handoffMessages: messages.length };
		if (lastMain && lastMain.model === payload.model) {
			const restored = restorePrefix(lastMain.messages, messages);
			fields.sentMessages = lastMain.messages.length;
			if (restored) {
				messages = restored.messages;
				fields.prefixRestored = true;
				fields.rewrittenMessages = restored.changed;
			} else {
				fields.prefixRestored = false;
			}
		} else {
			fields.prefixRestored = false;
			fields.reason = lastMain ? "model differs" : "no main turn seen yet";
		}
		let out: Payload = { ...payload, messages };
		if (current === "on") {
			const last = messages.length - 1;
			out.messages = [...messages.slice(0, last), appendLengthLimit(messages[last])];
			const budget = typeof payload.reasoning_budget_tokens === "number" && payload.reasoning_budget_tokens > 0 ? payload.reasoning_budget_tokens : Infinity;
			out.reasoning_budget_tokens = Math.min(budget, HANDOFF_THINKING_BUDGET);
			fields.maxChars = HANDOFF_MAX_CHARS;
			fields.thinkingBudget = out.reasoning_budget_tokens;
		}
		logger?.warn?.("strata handoff-speed: handoff request", fields);
		return out;
	};
}

export const PIN_MARKER = `<pinned reason="compaction">`;
export const PIN_OBJECTIVE_MAX = 1500;

type Entry = { type?: string; data?: unknown; message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown } };

/** The pinned note from the session branch, or undefined when there is nothing to pin. */
export function buildPin(branch: readonly Entry[], rules: string | undefined, systemPrompt: string | undefined): { text: string; fields: Record<string, unknown> } | undefined {
	let objective: string | undefined;
	let status: string | undefined;
	let phases: Array<{ name?: string; tasks?: Array<{ content?: string; status?: string }> }> | undefined;
	for (let i = branch.length - 1; i >= 0 && (objective === undefined || phases === undefined); i--) {
		const entry = branch[i];
		if (objective === undefined && entry?.type === "mode_change") {
			const goal = (entry.data as { goal?: { objective?: unknown; status?: unknown } } | undefined)?.goal;
			if (goal && typeof goal.objective === "string") {
				objective = goal.objective;
				status = typeof goal.status === "string" ? goal.status : undefined;
			}
		}
		const message = entry?.message;
		if (phases === undefined && message?.role === "toolResult" && message.toolName === "todo" && !message.isError) {
			const details = message.details as { op?: unknown; phases?: unknown } | undefined;
			if (details?.op !== "view" && Array.isArray(details?.phases)) phases = details.phases as typeof phases;
		}
	}
	const lines: string[] = [];
	const fields: Record<string, unknown> = {};
	if (objective && status !== "complete" && status !== "dropped") {
		const text = objective.length > PIN_OBJECTIVE_MAX ? `${objective.slice(0, PIN_OBJECTIVE_MAX)}…` : objective;
		lines.push(`Goal (verbatim): ${text}`);
		fields.goal = true;
	}
	if (phases) {
		const tasks = phases.flatMap(p => (p.tasks ?? []).map(t => ({ ...t, phase: p.name })));
		const current = tasks.find(t => t.status === "in_progress");
		const open = tasks.filter(t => t.status !== "completed" && t.status !== "abandoned").length;
		if (current?.content) lines.push(`Current item: ${current.content}${current.phase ? ` (${current.phase})` : ""}. Open items: ${open}.`);
		fields.item = !!current;
	}
	const rule = rules?.split("\n").find(line => line.trim())?.trim();
	if (rules && rule && !(systemPrompt ?? "").includes(rule)) {
		lines.push(`Rules (verbatim):\n${rules.trim()}`);
		fields.rules = "pinned";
	} else if (rules) {
		fields.rules = "in system prompt";
	}
	if (lines.length === 0) return undefined;
	return { text: [PIN_MARKER, "Compaction just replaced the older history. These still hold:", ...lines, "</pinned>"].join("\n"), fields };
}

/** The system prompt as text, whatever shape omp keeps it in (a string, or an array of parts). */
export function promptText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(part => (typeof part === "string" ? part : promptText((part as { text?: unknown; content?: unknown })?.text ?? (part as { content?: unknown })?.content) ?? "")).join("\n");
	if (value && typeof value === "object") return promptText((value as { text?: unknown }).text ?? (value as { content?: unknown }).content);
	return undefined;
}

function readRules(): string | undefined {
	try {
		const here = (import.meta as { dir?: string }).dir ?? nodePath.dirname(new URL(import.meta.url).pathname);
		return fs.readFileSync(process.env.OMP_STRATA_RULES_FILE || nodePath.join(here, "..", "RULES.md"), "utf8");
	} catch {
		return undefined;
	}
}

interface PinCtx {
	isIdle?: () => boolean;
	getSystemPrompt?: () => unknown;
	sessionManager?: { getBranch?: () => readonly Entry[] };
}

export default function (pi: {
	on(event: "before_provider_request", handler: (event: { payload: Payload }) => Payload | undefined): void;
	on(event: "session_compact", handler: (event: unknown, ctx?: PinCtx) => void | Promise<void>): void;
	sendMessage?: (message: { customType: string; content: string; display: boolean; attribution?: "user" | "agent" }, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean }) => void;
	logger?: Logger;
}): void {
	const pin = (process.env.OMP_STRATA_PIN ?? "on").trim().toLowerCase() !== "off";
	pi.logger?.warn?.("strata handoff-speed loaded", { mode: mode(), pin });
	const handle = createHandler(pi.logger);
	pi.on("before_provider_request", event => handle(event?.payload));
	if (!pin) return;
	pi.on("session_compact", (_event, ctx) => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			let systemPrompt: string | undefined;
			let promptType = "none";
			try {
				const raw = ctx?.getSystemPrompt?.();
				promptType = Array.isArray(raw) ? "array" : typeof raw;
				systemPrompt = promptText(raw);
			} catch {
				systemPrompt = undefined;
			}
			const note = buildPin(branch, readRules(), systemPrompt);
			if (!note) return;
			const idle = ctx?.isIdle?.() ?? false;
			pi.sendMessage?.({ customType: "strata-pin", content: note.text, display: false, attribution: "agent" }, { deliverAs: idle ? "nextTurn" : "steer" });
			pi.logger?.warn?.("strata pin: pinned after compaction", { ...note.fields, promptType, chars: note.text.length, deliverAs: idle ? "nextTurn" : "steer" });
		} catch (error) {
			pi.logger?.warn?.("strata pin: failed", { error: String(error) });
		}
	});
}
