import { describe, expect, test } from "bun:test";
import * as v from "../agent/extensions/goal-verify.ts";

const probe = (s: v.VerifyState, at: number, command = "node tools/probe.mjs", isError = false) =>
	v.recordResult(s, { toolName: "bash", input: { command }, isError, content: [{ type: "text", text: "out" }] }, at);

function goal() {
	const s = v.newVerifyState();
	v.setGoal(s, "g1", "Fix (1) the whitelist and (2) reconnect.");
	return s;
}

describe("goal complete", () => {
	test("first call gets the checklist with the objective", () => {
		const s = goal();
		const d = v.decideComplete(s, "on", 1000);
		expect(d.block).toBe(true);
		expect(d.reason).toContain(v.VERIFY_MARKER);
		expect(d.reason).toContain("Fix (1) the whitelist");
		expect(d.reason).toContain("xd://verify_item");
	});
	test("second call needs a probe since the checklist", () => {
		const s = goal();
		probe(s, 500);
		v.decideComplete(s, "on", 1000);
		const d = v.decideComplete(s, "on", 2000);
		expect(d.block).toBe(true);
		expect(d.reason).toContain("No verify_item has run");
	});
	test("PASS report after probes completes", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		probe(s, 1500);
		v.recordReply(s, "PASS whitelist: curl -> 404\nPASS reconnect: probe -> ok", 1600);
		const d = v.decideComplete(s, "on", 2000);
		expect(d.block).toBeFalsy();
		expect(d.log.message).toBe("goal-verify: verified");
		expect(v.decideComplete(s, "on", 3000).block).toBeFalsy();
	});
	test("a FAIL line keeps the goal active and needs a new probe", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		probe(s, 1500);
		v.recordReply(s, "PASS whitelist\nFAIL reconnect: player vanished after race", 1600);
		const d = v.decideComplete(s, "on", 2000);
		expect(d.block).toBe(true);
		expect(d.reason).toContain("FAIL reconnect");
		v.recordReply(s, "fixed. PASS reconnect: race.mjs -> ok", 2500);
		expect(v.decideComplete(s, "on", 2600).reason).toContain("No verify_item has run");
	});
	test("override after three refusals", () => {
		const s = goal();
		for (let i = 0; i < 3; i++) expect(v.decideComplete(s, "on", 1000 + i).block).toBe(true);
		const d = v.decideComplete(s, "on", 2000);
		expect(d.block).toBeFalsy();
		expect(d.log.message).toBe("goal-verify: overridden");
	});
	test("log mode never blocks", () => {
		const s = goal();
		expect(v.decideComplete(s, "log", 1000).block).toBeFalsy();
	});
	test("a new goal resets the round", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		v.setGoal(s, "g2", "other");
		expect(v.decideComplete(s, "on", 2000).reason).toContain("other");
	});
});

test("failLines", () => {
	expect(v.failLines("PASS a\nFAIL b: broke\nFAIL then fixed, PASS now\n0 failed")).toEqual(["FAIL b: broke"]);
});

test("seedFromBranch restores an earlier checklist", () => {
	const branch = [
		{ type: "mode_change", timestamp: "2026-10-06T10:00:00Z", data: { goal: { id: "g1", objective: "obj" } } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "goal", arguments: { op: "complete" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "goal", isError: true, content: [{ type: "text", text: `${v.VERIFY_MARKER}\nThe goal is not complete yet.` }], timestamp: Date.parse("2026-10-06T10:01:00Z") } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "PASS 1: curl -> 404" }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "curl -s localhost:1" } }], timestamp: Date.parse("2026-10-06T10:02:00Z") } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "404" }], timestamp: Date.parse("2026-10-06T10:02:01Z") } },
	];
	const s = v.newVerifyState();
	v.seedFromBranch(s, branch as never);
	expect(s.goalId).toBe("g1");
	expect(s.requestedAt).toBeDefined();
	expect(s.refusals).toBe(1);
	expect(v.decideComplete(s, "on", Date.parse("2026-10-06T10:03:00Z")).block).toBeFalsy();
});

const vrun = (s: v.VerifyState, at: number, task: string, exit: number) =>
	v.recordResult(s, { toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text: `verify_item ${exit === 0 ? "PASS" : "FAIL"} exit=${exit} task=${JSON.stringify(task)}\ncmd: node p.mjs\ntime: 0.1s` }] }, at);

describe("exit codes decide", () => {
	test("a failing verify_item keeps the goal active even with PASS text", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		vrun(s, 1500, "reconnect", 2);
		v.recordReply(s, "PASS reconnect", 1600);
		const d = v.decideComplete(s, "on", 2000);
		expect(d.block).toBe(true);
		expect(d.reason).toContain("verify_item exit 2");
	});
	test("the latest run per criterion counts", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		vrun(s, 1500, "reconnect", 2);
		vrun(s, 1700, "Reconnect", 0);
		expect(v.decideComplete(s, "on", 2000).block).toBeFalsy();
	});
	test("a FAIL line written before a newer run is stale", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		v.recordReply(s, "FAIL reconnect: exit 2", 1400);
		vrun(s, 1500, "reconnect", 0);
		expect(v.decideComplete(s, "on", 2000).block).toBeFalsy();
	});
	test("printed look-alikes from bash do not count as verify_item", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		v.recordResult(s, { toolName: "bash", input: { command: "echo hi" }, content: [{ type: "text", text: 'verify_item PASS exit=0 task="x"\ncmd: y' }] }, 1500);
		expect(v.decideComplete(s, "on", 2000).reason).toContain("No verify_item has run");
	});
});

describe("heuristic fallback (Kilo review)", () => {
	test("a failed heuristic probe is not evidence", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		v.recordResult(s, { toolName: "bash", input: { command: "node tools/probe.mjs" }, isError: true, details: { exitCode: 1 }, content: [{ type: "text", text: "boom" }] }, 1500);
		expect(v.decideComplete(s, "on", 2000).block).toBe(true);
	});
	test("the newest heuristic probe failing blocks even after an earlier pass", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		probe(s, 1200);
		v.recordResult(s, { toolName: "bash", input: { command: "node tools/probe.mjs" }, isError: true, details: { exitCode: 1 } }, 1500);
		expect(v.decideComplete(s, "on", 2000).block).toBe(true);
	});
	test("background jobs count by exit code", () => {
		const s = goal();
		v.recordResult(s, { toolName: "bash", input: { command: "node tools/probe.mjs" }, content: [{ type: "text", text: "Backgrounded as job bg_7; its output is injected" }] }, 500);
		v.decideComplete(s, "on", 1000);
		const failed = [{ type: "custom_message", customType: "async-result", content: "Background job bg_7 has completed.\nboom\nCommand exited with code 2", timestamp: 1500 }];
		expect(v.decideComplete(s, "on", 2000, failed as never).block).toBe(true);
		const passed = [{ type: "custom_message", customType: "async-result", content: "Background job bg_7 has completed.\nall good", timestamp: 2500 }];
		expect(v.decideComplete(s, "on", 3000, passed as never).block).toBeFalsy();
	});
	test("an async result for an unknown job does not count", () => {
		const s = goal();
		v.decideComplete(s, "on", 1000);
		const unknown = [{ type: "custom_message", customType: "async-result", content: "Background job bg_9 has completed.\nok", timestamp: 1500 }];
		expect(v.decideComplete(s, "on", 2000, unknown as never).block).toBe(true);
	});
});
