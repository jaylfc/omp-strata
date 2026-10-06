import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as l from "../agent/extensions/lessons.ts";

const seeded = l.loadLessons(path.join(import.meta.dir, "..", "agent", "lessons.jsonl"));

describe("globToRegExp", () => {
	test.each([
		["**/server/*.js", "cinderline/server/entry.js", true],
		["**/server/*.js", "server/entry.js", true],
		["**/server/*.js", "server/lib/x.js", false],
		["**/*walk*.{js,mjs,py}", "tools/pwalk2.mjs", true],
		["*.md", "docs/a.md", true],
		["src/?.ts", "src/a.ts", true],
	])("%s vs %s", (glob, p, want) => expect(l.globToRegExp(glob).test(p)).toBe(want));
});

describe("seed lessons", () => {
	test("all load, ids unique, short", () => {
		expect(seeded.length).toBeGreaterThanOrEqual(10);
		expect(new Set(seeded.map(x => x.id)).size).toBe(seeded.length);
		for (const x of seeded) expect(x.lesson.length).toBeLessThanOrEqual(l.MAX_LESSON_CHARS);
	});
	const ids = (result: { toolName: string; input: unknown; content?: unknown }) => l.pick(seeded, new Set(), l.facetsOf(result)).map(x => x.id);
	test("decodeURIComponent in a read file", () => {
		expect(ids({ toolName: "read", input: { path: "server/entry.js" }, content: [{ type: "text", text: "const p = decodeURIComponent(u)" }] })).toContain("L01");
	});
	test("pkill in bash", () => {
		expect(ids({ toolName: "bash", input: { command: "pkill -f 'server/entry.js'; node server/entry.js" } })).toContain("L04");
	});
	test("node --check", () => {
		expect(ids({ toolName: "bash", input: { command: "node --check server/net.js" } })).toContain("L12");
	});
	test("simulator", () => {
		expect(ids({ toolName: "bash", input: { command: "cd g && timeout 60 node tools/winsim.mjs" } })).toContain("L02");
	});
	test("topic on todo", () => {
		expect(ids({ toolName: "todo", input: { op: "init", items: ["P1-11 first wilds winnable with starter"] } })).toContain("L02");
	});
	test("edit text with a flag set", () => {
		expect(ids({ toolName: "edit", input: { path: "server/battle.js", new_string: "b.consumed = 'lantern';" } })).toContain("L05");
	});
	test("nothing for an unrelated read", () => {
		expect(ids({ toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "hello" }] })).toEqual([]);
	});
});

test("pick: at most 3, once per session", () => {
	const many = l.compile(Array.from({ length: 5 }, (_, i) => ({ id: `X${i}`, tags: ["cmd:go"], lesson: `rule ${i}` })));
	const shown = new Set<string>();
	const facets = l.facetsOf({ toolName: "bash", input: { command: "go" } });
	expect(l.pick(many, shown, facets).map(x => x.id)).toEqual(["X0", "X1", "X2"]);
	expect(l.pick(many, shown, facets).map(x => x.id)).toEqual(["X3", "X4"]);
	expect(l.pick(many, shown, facets)).toEqual([]);
});

test("render and shownInBranch round trip", () => {
	const text = l.render(l.compile([{ id: "L07", tags: ["cmd:x"], lesson: "r" }]));
	expect(text).toContain("[lesson L07] r");
	expect([...l.shownInBranch([{ type: "custom_message", content: text }])]).toEqual(["L07"]);
});

test("a bad regex tag disables only itself", () => {
	const c = l.compile([{ id: "B", tags: ["cmd:([", "cmd:ok"], lesson: "r" }]);
	expect(c[0].matchers.length).toBe(1);
});

test("proposal validation", () => {
	const f = { command: "node p.mjs", exit: 1 };
	expect(l.proposal({ lesson: "x".repeat(400), tags: ["cmd:a"] }, new Date(), f).ok).toBe(false);
	expect(l.proposal({ lesson: "rule", tags: [] }, new Date(), f).ok).toBe(false);
	const ok = l.proposal({ lesson: "rule", tags: ["cmd:a"], evidence: "e" }, new Date("2026-10-06T00:00:00Z"), f);
	expect(ok.ok && JSON.parse(ok.line)).toEqual({ tags: ["cmd:a"], lesson: "rule", evidence: "e", probe: f, proposed: "2026-10-06T00:00:00.000Z" });
});

test("lessons come only from probe-confirmed failures", () => {
	const none = l.proposal({ lesson: "rule", tags: ["cmd:a"] });
	expect(none.ok).toBe(false);
	expect(!none.ok && none.error).toContain("probe-confirmed");
	// A gate's refusal is not a failure; a failing probe is.
	expect(l.failureOf({ toolName: "todo", input: {}, isError: true, content: [{ type: "text", text: '<system-interrupt reason="done_gate">' }] })).toBeUndefined();
	expect(l.failureOf({ toolName: "bash", input: { command: "node tools/probe.mjs" }, isError: true, content: [{ type: "text", text: '<system-interrupt reason="tool_call_loop_blocked">' }] })).toBeUndefined();
	expect(l.failureOf({ toolName: "bash", input: { command: "ls nope" }, isError: true, details: { exitCode: 2 } })).toBeUndefined();
	expect(l.failureOf({ toolName: "bash", input: { command: "node tools/probe.mjs" }, isError: true, details: { exitCode: 3 } })).toEqual({ command: "node tools/probe.mjs", exit: 3 });
	expect(l.failureOf({ toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text: 'verify_item FAIL exit=2 task="a"\ncmd: node p.mjs' }] })).toEqual({ command: "node p.mjs", exit: 2 });
	expect(l.failureOf({ toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text: 'verify_item PASS exit=0 task="a"\ncmd: node p.mjs' }] })).toBeUndefined();
});

test("lastFailureInBranch", () => {
	const branch = [
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] } },
		{ message: { role: "toolResult", toolCallId: "c1", isError: true, details: { exitCode: 1 }, content: [] } },
	];
	expect(l.lastFailureInBranch(branch)).toEqual({ command: "npm test", exit: 1 });
});
