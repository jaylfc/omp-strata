import { expect, test } from "bun:test";
import {
	HANDOFF_MARKER,
	LENGTH_MARKER,
	LENGTH_INSTRUCTION,
	appendLengthLimit,
	isHandoffPayload,
	isMainTurnPayload,
	mode,
	restorePrefix,
	sameSlot,
} from "../agent/extensions/handoff-speed.ts";

const handoffPayload = {
	model: "m",
	messages: [{ role: "user", content: HANDOFF_MARKER }],
	tools: [],
};

test("isHandoffPayload true when last message is user with marker", () => {
	expect(isHandoffPayload(handoffPayload)).toBe(true);
});

test("isHandoffPayload false when last message is assistant", () => {
	const payload = { model: "m", messages: [{ role: "assistant", content: HANDOFF_MARKER }], tools: [] };
	expect(isHandoffPayload(payload)).toBe(false);
});

test("isHandoffPayload false for empty messages", () => {
	expect(isHandoffPayload({ model: "m", messages: [], tools: [] })).toBe(false);
});

test("isMainTurnPayload true with 2+ messages and non-empty tools", () => {
	expect(isMainTurnPayload({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }], tools: [{ fn: () => {} }] })).toBe(true);
});

test("isMainTurnPayload false with empty tools", () => {
	expect(isMainTurnPayload({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }], tools: [] })).toBe(false);
});

test("isMainTurnPayload false for a handoff payload", () => {
	expect(isMainTurnPayload(handoffPayload)).toBe(false);
});

test("sameSlot false when roles differ", () => {
	expect(sameSlot({ role: "user", content: "x", tool_call_id: "id" }, { role: "assistant", content: "x", tool_call_id: "id" })).toBe(false);
});

test("sameSlot false when tool_call_id differs", () => {
	expect(sameSlot({ role: "user", content: "x", tool_call_id: "a" }, { role: "user", content: "x", tool_call_id: "b" })).toBe(false);
});

test("sameSlot true for same role and ids with different content", () => {
	expect(sameSlot({ role: "user", content: "a", tool_call_id: "id" }, { role: "user", content: "b", tool_call_id: "id" })).toBe(true);
});

test("restorePrefix undefined for empty sent", () => {
	expect(restorePrefix([], [{ role: "user", content: HANDOFF_MARKER }])).toBeUndefined();
});

test("restorePrefix undefined when sent.length >= handoff.length", () => {
	const msgs = [{ role: "user", content: "hi" }];
	expect(restorePrefix(msgs, msgs)).toBeUndefined();
});

test("restorePrefix undefined when a slot does not line up", () => {
	const sent = [{ role: "user", content: "hi" }];
	const handoff = [{ role: "assistant", content: HANDOFF_MARKER }];
	expect(restorePrefix(sent, handoff)).toBeUndefined();
});

test("restorePrefix replaces prefix and counts exactly 1 changed", () => {
	const sent = [{ role: "user", content: "same", tool_call_id: "id", tool_calls: [{ id: "t1" }] }];
	const handoff = [
		{ role: "user", content: "changed", tool_call_id: "id", tool_calls: [{ id: "t1" }] },
		{ role: "user", content: HANDOFF_MARKER },
	];
	const result = restorePrefix(sent, handoff);
	expect(result).toEqual({ messages: [...sent, handoff[1]], changed: 1 });
});

test("appendLengthLimit appends instruction to string content", () => {
	const msg = { role: "user" as const, content: "some text" };
	const result = appendLengthLimit(msg);
	expect(result.content).toBe(`some text\n\n${LENGTH_INSTRUCTION}`);
	expect(result).not.toBe(msg);
});

test("appendLengthLimit appends extra text part to array content", () => {
	const msg = { role: "user" as const, content: [{ type: "text" as const, text: "part1" }] };
	const result = appendLengthLimit(msg);
	expect(Array.isArray(result.content)).toBe(true);
	expect((result.content as Array<{ type: string; text: string }>).length).toBe(2);
	expect((result.content as Array<{ type: string; text: string }>)[1]).toEqual({ type: "text", text: `\n\n${LENGTH_INSTRUCTION}` });
	expect(result).not.toBe(msg);
});

test("appendLengthLimit returns same object when LENGTH_MARKER present", () => {
	const msg = { role: "user" as const, content: LENGTH_MARKER };
	const result = appendLengthLimit(msg);
	expect(result).toBe(msg);
});

test("mode unset gives on", () => {
	expect(mode()).toBe("on");
});

test("mode OFF gives off", () => {
	const original = process.env.OMP_STRATA_HANDOFF_SPEED;
	process.env.OMP_STRATA_HANDOFF_SPEED = " OFF ";
	expect(mode()).toBe("off");
	process.env.OMP_STRATA_HANDOFF_SPEED = original;
});

test("mode prefix gives prefix", () => {
	const original = process.env.OMP_STRATA_HANDOFF_SPEED;
	process.env.OMP_STRATA_HANDOFF_SPEED = "prefix";
	expect(mode()).toBe("prefix");
	process.env.OMP_STRATA_HANDOFF_SPEED = original;
});

test("mode junk gives on", () => {
	const original = process.env.OMP_STRATA_HANDOFF_SPEED;
	process.env.OMP_STRATA_HANDOFF_SPEED = "junk";
	expect(mode()).toBe("on");
	process.env.OMP_STRATA_HANDOFF_SPEED = original;
});
