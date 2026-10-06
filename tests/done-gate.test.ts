import { describe, expect, test } from "bun:test";
import * as g from "../agent/extensions/done-gate.ts";

const modes = { goal: "on", todo: "on", scope: "on" } as const;
const phases = (tasks: Array<[string, string]>, name = "P") => ({ op: "init", phases: [{ name, tasks: tasks.map(([content, status]) => ({ content, status })) }] });

function seeded(tasks: Array<[string, string]>, name = "P") {
	const s = g.newState();
	g.record(s, { toolName: "todo", input: { op: "init" }, details: phases(tasks, name) }, 1000);
	return s;
}
const edit = (s: g.GateState, at: number, path = "src/a.js") => g.record(s, { toolName: "edit", input: { path, old_string: "x", new_string: "y" }, content: [{ type: "text", text: "ok" }] }, at);
const bash = (s: g.GateState, at: number, command: string, opts: { isError?: boolean; text?: string; exitCode?: number } = {}) =>
	g.record(s, { toolName: "bash", input: { command }, isError: opts.isError ?? false, content: [{ type: "text", text: opts.text ?? "ok" }], details: opts.exitCode === undefined ? {} : { exitCode: opts.exitCode } }, at);

describe("isProbeCommand", () => {
	test.each([
		"node --test", "cd app && bun test", "npm test", "pytest -q tests/", "curl -s http://127.0.0.1:8210/x",
		"cd cinderline && webcheck http://localhost:8201 --shot a.png", "node tools/hudcheck.mjs", "timeout 60 node tools/winsim.mjs",
		"python3 scripts/verify_upload.py", "node --input-type=module -e \"import { f } from './a.js'; console.log(f())\"",
		"rtk curl -I http://x", "bash -c 'node tools/probe.mjs'", "go test ./...",
	])("probe: %s", cmd => expect(g.isProbeCommand(cmd)).toBe(true));
	test.each([
		"node --check server/entry.js", "node --check tools/probe.mjs", "git status", "ls tools", "cat a.js | grep test",
		"grep -n verify src/*.js", "tsc --noEmit", "echo https://example.com", "python3 -m py_compile a.py", "node server/entry.js",
	])("not a probe: %s", cmd => expect(g.isProbeCommand(cmd)).toBe(false));
});

describe("classifyResult", () => {
	test("exit code and fail lines", () => {
		expect(g.classifyResult({ toolName: "bash", input: { command: "node t/probe.mjs" }, content: [{ type: "text", text: "PASS a\nPASS b" }] })?.kind).toBe("pass");
		expect(g.classifyResult({ toolName: "bash", input: { command: "node t/probe.mjs" }, isError: true, details: { exitCode: 1 } })?.kind).toBe("fail");
		expect(g.classifyResult({ toolName: "bash", input: { command: "node t/smoke.mjs" }, content: [{ type: "text", text: "ok: a\nFAIL battle resolved" }] })?.kind).toBe("fail");
		expect(g.classifyResult({ toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: "12 passed, 0 failed" }] })?.kind).toBe("pass");
		expect(g.classifyResult({ toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: "11 passed, 1 failed" }] })?.kind).toBe("fail");
		expect(g.classifyResult({ toolName: "bash", input: { command: "node t/probe.mjs" }, content: [{ type: "text", text: "Backgrounded as job bg_3; its output is injected" }] })).toMatchObject({ kind: "background", job: "bg_3" });
		expect(g.classifyResult({ toolName: "eval", input: { code: "tab = await browser.open('x')" } })?.kind).toBe("pass");
		expect(g.classifyResult({ toolName: "bash", input: { command: "node t/probe.mjs" }, content: [{ type: "text", text: `${g.MARKER}\nno` }] })).toBeUndefined();
	});
});

describe("todo done", () => {
	test("refuses without a probe, allows after one, probe must follow the last edit", () => {
		const s = seeded([["fix whitelist", "in_progress"]]);
		edit(s, 2000);
		const call = { toolName: "todo", input: { op: "done", task: "fix whitelist" } };
		const d1 = g.decide(s, call, modes);
		expect(d1?.block).toBe(true);
		expect(d1?.reason).toContain("fix whitelist");
		expect(d1?.reason).toContain("src/a.js");
		bash(s, 3000, "node --check src/a.js");
		expect(g.decide(s, call, modes)?.block).toBe(true);
		bash(s, 4000, "curl -s --path-as-is http://127.0.0.1:8210/../x");
		s.refusals.clear();
		expect(g.decide(s, call, modes)?.block).toBeFalsy();
		edit(s, 5000);
		expect(g.decide(s, call, modes)?.block).toBe(true);
	});
	test("a failing probe is not evidence", () => {
		const s = seeded([["a", "in_progress"]]);
		bash(s, 2000, "node tools/probe.mjs", { isError: true, exitCode: 3 });
		expect(g.decide(s, { toolName: "todo", input: { op: "done", task: "a" } }, modes)?.block).toBe(true);
	});
	test("a probe before the item opened does not count", () => {
		const s = g.newState();
		bash(s, 500, "npm test");
		g.record(s, { toolName: "todo", input: {}, details: phases([["late item", "in_progress"]]) }, 1000);
		expect(g.decide(s, { toolName: "todo", input: { op: "done", task: "late item" } }, modes)?.block).toBe(true);
	});
	test("override after two refusals of the same item", () => {
		const s = seeded([["a", "in_progress"]]);
		const call = { toolName: "todo", input: { op: "done", task: "a" } };
		expect(g.decide(s, call, modes)?.block).toBe(true);
		expect(g.decide(s, call, modes)?.block).toBe(true);
		const third = g.decide(s, call, modes);
		expect(third?.block).toBeFalsy();
		expect(third?.log?.message).toBe("done-gate: overridden");
	});
	test("log mode never blocks", () => {
		const s = seeded([["a", "in_progress"]]);
		const d = g.decide(s, { toolName: "todo", input: { op: "done", task: "a" } }, { ...modes, todo: "log" });
		expect(d?.block).toBeFalsy();
		expect(d?.log?.message).toBe("done-gate: would refuse");
	});
	test("already completed tasks are not claims", () => {
		const s = seeded([["a", "completed"]]);
		expect(g.decide(s, { toolName: "todo", input: { op: "done", task: "a" } }, modes)).toBeUndefined();
	});
	test("background job evidence from async-result", () => {
		const s = seeded([["a", "in_progress"]]);
		edit(s, 2000);
		bash(s, 3000, "node tools/probe.mjs", { text: "Backgrounded as job bg_2; its output is injected" });
		const call = { toolName: "todo", input: { op: "done", task: "a" } };
		const bad = [{ type: "custom_message", customType: "async-result", content: "Background job bg_2 has completed.\nboom\nCommand exited with code 7", timestamp: 4000 }];
		expect(g.decide(s, call, modes, bad)?.block).toBe(true);
		const good = [{ type: "custom_message", customType: "async-result", content: "Background job bg_2 has completed.\nPASS all\nWall time: 1s", timestamp: 4000 }];
		s.refusals.clear();
		expect(g.decide(s, call, modes, good)?.block).toBeFalsy();
	});
});

describe("scope fix", () => {
	const s = seeded([["one", "in_progress"], ["two", "pending"], ["three", "pending"]]);
	test("one named item becomes task", () => {
		expect(g.scopeFix(s.phases, { op: "done", i: "x", items: ["two"] })).toEqual({ input: { i: "x", op: "done", task: "two" } });
	});
	test("a whole phase becomes phase", () => {
		expect(g.scopeFix(s.phases, { op: "done", list: [{ phase: "P", items: ["one", "two", "three"] }] })).toEqual({ input: { op: "done", phase: "P" } });
		expect(g.scopeFix(s.phases, { op: "done", list: JSON.stringify([{ phase: "P", items: ["three", "two", "one"] }]) })).toEqual({ input: { op: "done", phase: "P" } });
	});
	test("several items are refused", () => {
		const fix = g.scopeFix(s.phases, { op: "done", items: ["one", "two"] });
		expect(fix && "refuse" in fix && fix.refuse).toContain("all 3 open tasks");
	});
	test("task or phase present: untouched", () => {
		expect(g.scopeFix(s.phases, { op: "done", task: "one", items: ["two"] })).toBeUndefined();
		expect(g.scopeFix(s.phases, { op: "start", items: ["two"] })).toBeUndefined();
	});
	test("decide applies the rewrite before the evidence check", () => {
		const st = seeded([["one", "in_progress"], ["two", "pending"]]);
		bash(st, 2000, "npm test");
		const d = g.decide(st, { toolName: "todo", input: { op: "done", items: ["one"] } }, modes);
		expect(d?.block).toBeFalsy();
		expect(d?.input).toEqual({ op: "done", task: "one" });
	});
	test("bulk done with no names counts every open task", () => {
		const st = seeded([["one", "in_progress"], ["two", "pending"]]);
		const d = g.decide(st, { toolName: "todo", input: { op: "done" } }, modes);
		expect(d?.block).toBe(true);
		expect(d?.reason).toContain("mark 2 tasks done");
	});
});

describe("goal complete", () => {
	test("needs a probe after the last edit", () => {
		const s = g.newState();
		edit(s, 1000);
		const call = { toolName: "goal", input: { op: "complete" } };
		expect(g.decide(s, call, modes)?.block).toBe(true);
		bash(s, 2000, "node tools/e2e-check.mjs");
		s.refusals.clear();
		expect(g.decide(s, call, modes)?.block).toBeFalsy();
	});
	test("other goal ops pass", () => {
		expect(g.decide(g.newState(), { toolName: "goal", input: { op: "get" } }, modes)).toBeUndefined();
	});
});

test("seedFromBranch rebuilds state", () => {
	const branch = [
		{ type: "message", timestamp: "2026-10-06T10:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "todo", arguments: { op: "init" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [], details: phases([["a", "in_progress"]]), timestamp: Date.parse("2026-10-06T10:00:01Z") } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "ok" }], details: {}, timestamp: Date.parse("2026-10-06T10:01:00Z") } },
	];
	const s = g.newState();
	g.seedFromBranch(s, branch as g.BranchEntry[]);
	expect(s.phases[0].tasks[0].content).toBe("a");
	expect(s.probes.length).toBe(1);
	expect(g.decide(s, { toolName: "todo", input: { op: "done", task: "a" } }, modes)?.block).toBeFalsy();
});

test("omp devices and buffers are not file changes", () => {
	expect(g.changedPaths({ toolName: "write", input: { path: "xd://lesson_propose", content: "{}" } })).toEqual([]);
	expect(g.changedPaths({ toolName: "write", input: { path: "proc://bg_1", content: "" } })).toEqual([]);
	expect(g.changedPaths({ toolName: "edit", input: { input: "[src/a.js#1A2B]\nPUT 1:x" } })).toEqual(["src/a.js"]);
});

describe("verify_item", () => {
	test.each(["", "echo PASS", "true", "node --check a.js", "cd app && git status", "cat out.txt | grep ok", "bash -n x.sh", "ls && tsc --noEmit"])("refused: %s", cmd => {
		expect(g.verifyCommandProblem(cmd)).toBeDefined();
	});
	test.each(["node tools/race.mjs", "cd cinderline && timeout 60 node tools/mill.mjs", "curl -sf http://127.0.0.1:8210/%", "PORT=8210 node tools/hc.mjs heal", "npm test", "python3 -c 'import app; assert app.ok()'", "node probe.mjs | tail -5"])("accepted: %s", cmd => {
		expect(g.verifyCommandProblem(cmd)).toBeUndefined();
	});
	test("result text round trip and spoof guard", () => {
		const text = g.formatVerify('Fix "the" widget', "node p.mjs", 3, 1.25, "line1\nFAIL x");
		expect(text.split("\n")[0]).toBe('verify_item FAIL exit=3 task="Fix \\"the\\" widget"');
		expect(g.parseVerifyText(text)).toEqual({ task: 'Fix "the" widget', command: "node p.mjs", exit: 3 });
		expect(g.verificationOf({ toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text }] })?.exit).toBe(3);
		expect(g.verificationOf({ toolName: "verify_item", input: {}, content: [{ type: "text", text }] })?.exit).toBe(3);
		expect(g.verificationOf({ toolName: "bash", input: { command: "echo" }, content: [{ type: "text", text }] })).toBeUndefined();
		expect(g.parseVerifyText(g.formatVerify("t", "c", "timeout", 120, ""))?.exit).toBe(-1);
	});
	test("tail keeps the last 40 lines", () => {
		const out = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
		const tail = g.tailOf(out);
		expect(tail.startsWith("…\n")).toBe(true);
		expect(tail.endsWith("l99")).toBe(true);
		expect(tail.split("\n").length).toBe(41);
	});
	test("commandFromText and resolveCommand", () => {
		expect(g.commandFromText("P1-9 whitelist: `curl -sf --path-as-is http://x/../a` gives 404")).toBe("curl -sf --path-as-is http://x/../a");
		expect(g.commandFromText("use `node --check a.js`")).toBeUndefined();
		const s = g.newState();
		s.commands.set("Fix it", "node p.mjs");
		expect(g.resolveCommand(s, "fix it", undefined)).toBe("node p.mjs");
		expect(g.resolveCommand(s, "other", " npm test ")).toBe("npm test");
	});
	test("runProbe: exit code, pipefail, timeout", async () => {
		expect((await g.runProbe("echo hi; exit 4", "/tmp", 10)).exit).toBe(4);
		const piped = await g.runProbe("node -e 'process.exit(2)' | cat", "/tmp", 10);
		expect(piped.exit).toBe(2);
		const ok = await g.runProbe("echo PASS", "/tmp", 10);
		expect(ok.exit).toBe(0);
		expect(ok.output).toContain("PASS");
		const slow = await g.runProbe("sleep 5", "/tmp", 0.3);
		expect(slow.exit).toBe("timeout");
		expect(slow.seconds).toBeLessThan(3);
	});
	test("a background child holding stdout does not hang it", async () => {
		const run = await g.runProbe("(sleep 30 &) ; echo started", "/tmp", 10);
		expect(run.exit).toBe(0);
		expect(run.seconds).toBeLessThan(5);
	});
});

describe("verify evidence mode", () => {
	const vm = { ...modes, evidence: "verify" } as const;
	const vi = (s: g.GateState, at: number, task: string, exit: number) =>
		g.record(s, { toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text: g.formatVerify(task, "node p.mjs", exit, 0.1, "") }] }, at);
	test("todo needs a passing verify_item for that item after the last edit", () => {
		const s = seeded([["Fix the widget", "in_progress"], ["Other", "pending"]]);
		edit(s, 2000);
		bash(s, 2500, "npm test");
		const call = { toolName: "todo", input: { op: "done", task: "Fix the widget" } };
		const d = g.decide(s, call, vm);
		expect(d?.block).toBe(true);
		expect(d?.reason).toContain("xd://verify_item");
		expect(d?.reason).toContain('"task":"Fix the widget"');
		expect(d?.log?.fields.heuristicWouldPass).toBe(true);
		vi(s, 3000, "Other", 0);
		s.refusals.clear();
		expect(g.decide(s, call, vm)?.block).toBe(true);
		vi(s, 3100, "fix the widget", 1);
		s.refusals.clear();
		expect(g.decide(s, call, vm)?.reason).toContain("latest verify_item failed (exit 1");
		vi(s, 3200, "Fix the widget", 0);
		s.refusals.clear();
		expect(g.decide(s, call, vm)?.block).toBeFalsy();
		edit(s, 4000);
		expect(g.decide(s, call, vm)?.block).toBe(true);
	});
	test("goal needs every task verified since the last edit to pass its latest run", () => {
		const s = g.newState();
		edit(s, 1000);
		const call = { toolName: "goal", input: { op: "complete" } };
		expect(g.decide(s, call, vm)?.block).toBe(true);
		vi(s, 2000, "a", 0);
		vi(s, 2100, "b", 5);
		s.refusals.clear();
		expect(g.decide(s, call, vm)?.block).toBe(true);
		vi(s, 2200, "b", 0);
		s.refusals.clear();
		expect(g.decide(s, call, vm)?.block).toBeFalsy();
	});
	test("verify_item writes are not file changes and their passes also count as probes", () => {
		const s = seeded([["a", "in_progress"]]);
		edit(s, 2000);
		vi(s, 3000, "a", 0);
		expect(s.lastEdit?.at).toBe(2000);
		expect(s.probes.length).toBe(1);
	});
});
