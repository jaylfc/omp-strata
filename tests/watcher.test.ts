import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { armDoneGate, decide, disarmDoneGate, doneGateArmed, effectiveTodoMode, newState, record } from "../agent/extensions/done-gate.ts";
import watcher, {
	cascadeConfirms,
	cascadeFlag,
	runCascade,
	samePath,
	askWatcher,
	buildDigest,
	loadConfig,
	parseSystem1,
	parseSystem2,
	redact,
	ruleVerdict,
	STATES,
	system1Body,
	system2Messages,
	WatchController,
	type Verdict,
} from "../agent/extensions/watcher.ts";

const T0 = Date.parse("2026-10-06T13:00:00Z");
let seq = 0;

/** A session branch: assistant toolCall + toolResult pairs, like omp writes them. */
function call(name: string, args: Record<string, unknown>, text: string, opts: { isError?: boolean; exit?: number; details?: unknown; at?: number } = {}) {
	const id = `c${++seq}`;
	const at = opts.at ?? T0 + seq * 30000;
	return [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: at - 1000 } },
		{
			type: "message",
			message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: !!opts.isError, details: opts.details ?? (opts.exit !== undefined ? { exitCode: opts.exit } : {}), timestamp: at },
		},
	];
}
function todo(tasks: Array<[string, string]>) {
	return call("todo", { op: "update" }, "ok", { details: { op: "update", phases: [{ name: "P", tasks: tasks.map(([content, status]) => ({ content, status })) }] } });
}
const goal = { type: "mode_change", data: { goal: { objective: "Fix the nine release items.", status: "active" } } };

afterEach(() => disarmDoneGate());

test("digest: item, edits, commits, probes, repeats and guard events come from the branch", () => {
	const branch = [
		goal,
		...todo([["Fix login", "in_progress"], ["Fix logout", "pending"]]),
		...call("read", { path: "src/a.js" }, "[src/a.js#AB12]\n1:x"),
		...call("edit", { path: "src/a.js", input: "[src/a.js#AB12]\nPUT 1:y" }, "ok"),
		...call("bash", { command: "node tools/probe.mjs" }, "PASS\n\nWall time: 0.2 seconds"),
		...call("bash", { command: "git commit -am 'Fix login'" }, "[main 1a2b3c] Fix login"),
		...call("bash", { command: "node tools/where.mjs" }, "Ada@ashvale"),
		...call("bash", { command: "node tools/where.mjs" }, "Ada@ashvale"),
		...call("bash", { command: "node tools/where.mjs" }, "Ada@ashvale"),
		...call("bash", { command: "node tools/where.mjs" }, '<system-interrupt reason="tool_call_loop_blocked">\nrefused\n</system-interrupt>', { isError: true }),
		{ type: "custom_message", customType: "tool-call-loop-redirect", content: "loop" },
	];
	const d = buildDigest(branch);
	expect(d.facts.item).toBe("Fix login");
	expect(d.facts.editsItem).toBe(1);
	expect(d.facts.commitsItem).toBe(1);
	expect(d.facts.probesPassItem).toBe(1);
	expect(d.facts.maxCommandRepeat).toBe(4);
	expect(d.facts.guardWindow).toBe(2);
	expect(d.facts.guardKinds).toContain("tool_call_loop_blocked");
	expect(d.text).toContain("CURRENT ITEM: Fix login");
	expect(d.text).toContain("GOAL: Fix the nine release items.");
	expect(d.text).toContain("REFUSED (tool_call_loop_blocked)");
	expect(d.text.split("\n").filter(l => /^\d+\. /.test(l)).length).toBeLessThanOrEqual(12);
});

test("claims: todo done without a probe after the last edit is marked, with one it is not", () => {
	const unproven = [goal, ...todo([["Fix login", "in_progress"]]), ...call("edit", { path: "src/a.js" }, "ok"), ...call("todo", { op: "done", task: "Fix login" }, "ok")];
	const a = buildDigest(unproven).facts.claims;
	expect(a).toHaveLength(1);
	expect(a[0].evidenced).toBe(false);
	const proven = [goal, ...todo([["Fix login", "in_progress"]]), ...call("edit", { path: "src/a.js" }, "ok"), ...call("bash", { command: "node --test" }, "ok"), ...call("todo", { op: "done", task: "Fix login" }, "ok")];
	expect(buildDigest(proven).facts.claims[0].evidenced).toBe(true);
	expect(ruleVerdict(buildDigest(unproven).facts).state).toBe("overclaiming");
});

test("rules: repeats are looping, steady work is progressing", () => {
	const loop = [goal, ...todo([["Item", "in_progress"]]), ...Array.from({ length: 6 }, () => call("read", { path: "server/net.js:132-137" }, "x")).flat()];
	expect(ruleVerdict(buildDigest(loop).facts).state).toBe("looping");
	const work = [goal, ...todo([["Item", "in_progress"]]), ...["a", "b", "c"].flatMap(f => [...call("read", { path: `src/${f}.js` }, "x"), ...call("edit", { path: `src/${f}.js` }, "ok")])];
	expect(ruleVerdict(buildDigest(work).facts).state).toBe("progressing");
});

test("redact: passwords and tokens never reach the digest", () => {
	expect(redact("sshpass -p hunter2 ssh x")).not.toContain("hunter2");
	expect(redact("the password alexander99 works")).not.toContain("alexander99");
	expect(redact("token=abc123def")).not.toContain("abc123def");
	const d = buildDigest([goal, ...call("bash", { command: "sshpass -p s3cret ssh jay@mac uptime" }, "up 3 days")]);
	expect(d.text).not.toContain("s3cret");
});

test("system1 body: one described choice over the six states, shuffled by seed, plus a steer choice", () => {
	const d = buildDigest([goal, ...todo([["Item", "in_progress"]]), ...call("edit", { path: "a.js" }, "ok")]);
	const body = system1Body(d.text, d.facts, 1) as { state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> };
	expect(body.state).toBe(d.text);
	expect(Object.keys(body.questions.state.criteria).sort()).toEqual([...STATES].sort());
	expect(body.questions.state.criteria.looping).toContain("most repeated command x");
	expect(body.questions.steer.type).toBe("choice");
	const other = system1Body(d.text, d.facts, 99) as typeof body;
	expect(Object.keys(other.questions.state.criteria)).not.toEqual(Object.keys(body.questions.state.criteria));
	const v = parseSystem1({ answers: { state: { choice: "looping", probabilities: { looping: 0.7, progressing: 0.3 } }, steer: { choice: "new_approach" } } }, d.facts);
	expect(v.state).toBe("looping");
	expect(v.confidence).toBe(0.7);
	expect(v.steer).toContain("different approach");
});

test("system2: JSON verdicts parse, sloppy ones are normalised or rejected", () => {
	expect(parseSystem2('{"state":"looping","confidence":0.9,"steer":"stop"}')?.state).toBe("looping");
	expect(parseSystem2('Sure! {"state":"stuck-env","confidence":85,"steer":""}')?.state).toBe("stuck_env");
	expect(parseSystem2('{"state":"stuck-env","confidence":85,"steer":""}')?.confidence).toBe(0.85);
	expect(parseSystem2('{"state":"great","confidence":1}')).toBeUndefined();
	expect(parseSystem2("no json")).toBeUndefined();
	expect(system2Messages("digest")[1]).toEqual({ role: "user", content: "digest" });
});

test("askWatcher: chat and system1 requests go to the right paths; rules need no endpoint", async () => {
	const d = buildDigest([goal, ...todo([["Item", "in_progress"]])]);
	const seen: string[] = [];
	const fake = async (url: string, init: { body: string }) => {
		seen.push(url);
		const body = JSON.parse(init.body);
		if (url.endsWith("/systemone")) return { ok: true, status: 200, json: async () => ({ answers: { state: { choice: "waiting", probabilities: { waiting: 0.6 } }, steer: { choice: "none" } } }) };
		expect(body.response_format.type).toBe("json_schema");
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"state":"progressing","confidence":0.8,"steer":""}' } }] }) };
	};
	const base = loadConfig({}, {});
	expect((await askWatcher({ ...base, api: "chat", url: "http://mac:1234/v1" }, d.text, d.facts, fake)).state).toBe("progressing");
	expect((await askWatcher({ ...base, api: "system1", url: "http://mac:8900/v1" }, d.text, d.facts, fake)).state).toBe("waiting");
	expect(seen).toEqual(["http://mac:1234/v1/chat/completions", "http://mac:8900/v1/systemone"]);
	expect((await askWatcher({ ...base, api: "rules" }, d.text, d.facts, fake)).source).toBe("rules");
});

const facts = buildDigest([goal, ...todo([["Item", "in_progress"]])]).facts;
const v = (state: Verdict["state"], confidence: number): Verdict => ({ state, confidence, steer: "do x", source: "test" });

test("controller: a steer needs two consecutive same-state verdicts at or above the threshold", () => {
	const c = new WatchController({ mode: "steer", threshold: 0.8, steerGapMin: 15 });
	expect(c.onVerdict(v("looping", 0.9), facts, 0).steer).toBeUndefined();
	expect(c.onVerdict(v("drifting", 0.9), facts, 1).steer).toBeUndefined();
	expect(c.onVerdict(v("drifting", 0.7), facts, 2).steer).toBeUndefined();
	expect(c.onVerdict(v("drifting", 0.9), facts, 3).steer).toBeUndefined();
	const d = c.onVerdict(v("drifting", 0.95), facts, 4);
	expect(d.steer).toContain("Watcher (drifting, 95%): do x");
	// Rate limit: the same confirmed state inside the gap is not steered again.
	expect(c.onVerdict(v("drifting", 0.95), facts, 5).steer).toBeUndefined();
	expect(c.onVerdict(v("drifting", 0.95), facts, 16 * 60000).steer).toBeDefined();
});

test("controller: log mode never steers or arms; progressing and waiting never steer; guard keeps looping", () => {
	const log = new WatchController({ mode: "log", threshold: 0.5, steerGapMin: 15 });
	log.onVerdict(v("overclaiming", 0.9), facts, 0);
	const d = log.onVerdict(v("overclaiming", 0.9), facts, 1);
	expect(d.steer).toBeUndefined();
	expect(d.armGate).toBe(false);
	const steer = new WatchController({ mode: "steer", threshold: 0.5, steerGapMin: 15 });
	steer.onVerdict(v("waiting", 1), facts, 0);
	expect(steer.onVerdict(v("waiting", 1), facts, 1).steer).toBeUndefined();
	steer.onVerdict(v("looping", 0.9), { ...facts, guardWindow: 2 }, 2);
	expect(steer.onVerdict(v("looping", 0.9), { ...facts, guardWindow: 2 }, 3).note).toContain("fail-loop guard");
	const first = steer.onVerdict(v("overclaiming", 0.9), facts, 4);
	expect(first.armGate).toBe(true);
	expect(first.steer).toBeUndefined();
	expect(steer.onVerdict(v("overclaiming", 0.3), facts, 4.5).armGate).toBeFalsy();
	steer.onVerdict(v("overclaiming", 0.9), facts, 4.7);
	const o = steer.onVerdict(v("overclaiming", 0.9), facts, 5);
	expect(o.armGate).toBe(true);
	expect(o.steer).toContain("overclaiming");
});

test("done gate: an armed watcher verdict checks the next todo done as if the gate were on, once", () => {
	const state = newState();
	record(state, { toolName: "todo", input: { op: "update" }, details: { op: "update", phases: [{ name: "P", tasks: [{ content: "Fix login", status: "in_progress" }] }] } }, 1);
	record(state, { toolName: "edit", input: { path: "a.js" }, content: [{ type: "text", text: "ok" }] }, 2);
	const call = { toolName: "todo", input: { op: "done", task: "Fix login" } };
	expect(effectiveTodoMode("log", call.toolName, call.input).mode).toBe("log");
	expect(decide(state, call, { goal: "on", todo: "log", scope: "on", evidence: "verify" })?.block).toBeUndefined();
	armDoneGate("Fix login", "overclaiming 0.9", 30, 1000);
	const eff = effectiveTodoMode("log", call.toolName, call.input, 2000);
	expect(eff.mode).toBe("on");
	expect(decide(state, call, { goal: "on", todo: eff.mode, scope: "on", evidence: "verify" })?.block).toBe(true);
	expect(effectiveTodoMode("log", "bash", {}, 2000).mode).toBe("log");
	expect(effectiveTodoMode("off", call.toolName, call.input, 2000).mode).toBe("off");
	expect(doneGateArmed(31 * 60000 + 1000)).toBeUndefined();
});

test("config: environment wins over settings.env, bad values fall back", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "watcher-"));
	const file = path.join(dir, "settings.env");
	writeFileSync(file, 'WATCHER_MODE=steer\nWATCHER_URL="http://mac:8900/v1/"\nWATCHER_API=system1\nWATCHER_THRESHOLD=0.4\nSIDE_MODEL_ID=x\n');
	const { readSettings } = require("../agent/extensions/watcher.ts");
	const s = readSettings(file);
	const fromFile = loadConfig({}, s);
	expect(fromFile).toMatchObject({ mode: "steer", api: "system1", url: "http://mac:8900/v1", threshold: 0.4 });
	expect(loadConfig({ OMP_STRATA_WATCHER: "off" }, s).mode).toBe("off");
	const side = readSettings((() => { writeFileSync(file, "SIDE_BASE_URL=http://mac:1234/v1\nSIDE_MODEL_ID=google/gemma-4-12b-qat\n"); return file; })());
	expect(loadConfig({}, side)).toMatchObject({ url: "http://mac:1234/v1", model: "google/gemma-4-12b-qat", api: "chat" });
	expect(loadConfig({ OMP_STRATA_WATCHER: "loud", OMP_STRATA_WATCHER_EVERY: "-3" }, {})).toMatchObject({ mode: "log", every: 8, api: "chat" });
	rmSync(dir, { recursive: true });
});

test("extension: log mode checks in the background every N results and logs, never steering", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "watcher-"));
	const logFile = path.join(dir, "watcher.jsonl");
	const env = { OMP_STRATA_WATCHER: "log", OMP_STRATA_WATCHER_API: "rules", OMP_STRATA_WATCHER_EVERY: "3", OMP_STRATA_WATCHER_LOG: logFile };
	const saved: Record<string, string | undefined> = {};
	for (const [k, val] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = val;
	}
	try {
		const branch: unknown[] = [goal, ...todo([["Item", "in_progress"]])];
		const handlers: Record<string, (e: unknown, ctx?: unknown) => unknown> = {};
		const steers: string[] = [];
		watcher({
			on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
				handlers[event] = handler;
			},
			sendUserMessage: (text: string) => steers.push(text),
			logger: { warn: () => {} },
		} as never);
		const ctx = { sessionManager: { getBranch: () => branch } };
		handlers.session_start({}, ctx);
		for (let i = 0; i < 7; i++) {
			branch.push(...call("read", { path: "server/net.js:132-137" }, "x"));
			const ret = handlers.tool_result({ toolName: "read" }, ctx);
			expect(ret).toBeUndefined();
			await new Promise(r => setTimeout(r, 5));
		}
		await new Promise(r => setTimeout(r, 50));
		const rows = readFileSync(logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
		expect(rows.length).toBe(2);
		expect(rows[1].verdict.state).toBe("looping");
		expect(rows[1].digest).toContain("server/net.js:132-137");
		expect(steers).toEqual([]);
	} finally {
		for (const [k, val] of Object.entries(saved)) {
			if (val === undefined) delete process.env[k];
			else process.env[k] = val;
		}
		rmSync(dir, { recursive: true });
	}
});

test("samePath: resolved against the working directory; a shared suffix is not enough", () => {
	const cwd = "/home/jay/dev/strata/omp";
	expect(samePath("cinderline/server/net.js", "/home/jay/dev/strata/omp/cinderline/server/net.js", cwd)).toBe(true);
	expect(samePath("./a.js", "a.js", cwd)).toBe(true);
	expect(samePath("a.js", "src/a.js", cwd)).toBe(false);
	expect(samePath("a.js", "/a.js", cwd)).toBe(false);
	expect(samePath("src/a.js", "lib/a.js", cwd)).toBe(false);
	// Without a working directory only identical paths match.
	expect(samePath("a.js", "/a.js")).toBe(false);
	expect(samePath("x/../a.js", "a.js")).toBe(true);
});

test("re-reads of one file are not reset by an edit to another file with the same name", () => {
	const branch = [
		goal,
		...todo([["Item", "in_progress"]]),
		...Array.from({ length: 3 }, () => call("read", { path: "src/a.js" }, "x")).flat(),
		...call("edit", { path: "lib/a.js" }, "ok"),
		...Array.from({ length: 2 }, () => call("read", { path: "src/a.js" }, "x")).flat(),
	];
	expect(buildDigest(branch).facts.maxFileReads).toBe(5);
	const fixed = [...branch.slice(0, -4), ...call("edit", { path: "src/a.js" }, "ok"), ...call("read", { path: "src/a.js" }, "x")];
	expect(buildDigest(fixed).facts.maxFileReads).toBe(3);
});

test("editsWindow counts ast_edit even when its path is only in the result text", () => {
	const branch = [goal, ...todo([["Item", "in_progress"]]), ...call("ast_edit", { pattern: "foo" }, "[src/a.js#AB12]\nok")];
	expect(buildDigest(branch).facts.editsWindow).toBe(1);
});

test("cascade flag: overclaiming on one verdict; other problems need rules and two System One verdicts in a row", () => {
	expect(cascadeFlag(v("overclaiming", 0.8), v("progressing", 0.9), undefined, 0.3)).toBe("overclaiming");
	expect(cascadeFlag(v("progressing", 0.6), v("overclaiming", 0.35), undefined, 0.3)).toBe("overclaiming");
	expect(cascadeFlag(v("looping", 0.7), v("looping", 0.5), v("looping", 0.4), 0.3)).toBe("looping");
	expect(cascadeFlag(v("looping", 0.7), v("looping", 0.5), v("drifting", 0.4), 0.3)).toBeUndefined();
	expect(cascadeFlag(v("looping", 0.7), v("looping", 0.5), undefined, 0.3)).toBeUndefined();
	expect(cascadeFlag(v("progressing", 0.6), v("looping", 0.9), v("looping", 0.9), 0.3)).toBeUndefined();
	expect(cascadeFlag(v("looping", 0.7), v("looping", 0.2), v("looping", 0.9), 0.3)).toBeUndefined();
	expect(cascadeConfirms("overclaiming", undefined)).toBe(true);
	expect(cascadeConfirms("looping", v("drifting", 0.9))).toBe(true);
	expect(cascadeConfirms("looping", v("progressing", 0.9))).toBe(false);
	expect(cascadeConfirms("looping", undefined)).toBe(false);
	expect(cascadeConfirms(undefined, v("looping", 1))).toBe(false);
});

test("runCascade: the chat model is asked only for non-overclaiming flags and writes the steer", async () => {
	const loop = [goal, ...todo([["Item", "in_progress"]]), ...Array.from({ length: 6 }, () => call("read", { path: "server/net.js:132-137" }, "x")).flat()];
	const d = buildDigest(loop);
	const asked: string[] = [];
	const fake = (s1State: string, chatState: string) => async (url: string) => {
		asked.push(url);
		if (url.endsWith("/systemone")) return { ok: true, status: 200, json: async () => ({ answers: { state: { choice: s1State, probabilities: { [s1State]: 0.6 } }, steer: { choice: "none" } } }) };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ state: chatState, confidence: 0.9, steer: "Stop re-reading net.js; edit input.js." }) } }] }) };
	};
	const cfg = { ...loadConfig({}, {}), api: "cascade" as const, url: "http://mac:1234/v1", s1Url: "http://mac:8900/v1", s1Threshold: 0.3 };
	const prev = v("looping", 0.5);
	const yes = await runCascade(cfg, d.text, d.facts, prev, fake("looping", "looping"));
	expect(yes.confirmed).toBe(true);
	expect(yes.verdict.state).toBe("looping");
	expect(yes.verdict.steer).toBe("Stop re-reading net.js; edit input.js.");
	expect(asked).toEqual(["http://mac:8900/v1/systemone", "http://mac:1234/v1/chat/completions"]);
	const no = await runCascade(cfg, d.text, d.facts, prev, fake("looping", "progressing"));
	expect(no.confirmed).toBe(false);
	expect(no.verdict.state).toBe("progressing");
	asked.length = 0;
	const first = await runCascade(cfg, d.text, d.facts, undefined, fake("looping", "looping"));
	expect(first.flag).toBeUndefined();
	expect(asked).toEqual(["http://mac:8900/v1/systemone"]);
	const c = new WatchController({ mode: "steer", threshold: 0.9, steerGapMin: 15 });
	expect(c.onCascade(yes, d.facts, 0).steer).toContain("Watcher (looping, cascade): Stop re-reading net.js");
	expect(c.onCascade(no, d.facts, 1).note).toContain("vetoed by progressing");
	expect(c.s1Prev?.state).toBe("looping");
	const claim = { verdict: { ...v("overclaiming", 0.4), steer: "verify" }, flag: "overclaiming" as const, confirmed: true, s1: v("overclaiming", 0.4), s1Threshold: 0.3 };
	expect(new WatchController({ mode: "steer", threshold: 0.9, steerGapMin: 15 }).onCascade(claim, d.facts, 0).armGate).toBe(true);
	const weak = { ...claim, s1: v("overclaiming", 0.2) };
	expect(new WatchController({ mode: "steer", threshold: 0.9, steerGapMin: 15 }).onCascade(weak, d.facts, 0).armGate).toBe(false);
	const log = new WatchController({ mode: "log", threshold: 0.9, steerGapMin: 15 });
	const logged = log.onCascade(yes, d.facts, 0);
	expect(logged.steer).toBeUndefined();
	expect(logged.armGate).toBe(false);
});

test("config: a System One URL makes the cascade the default; without it the API stays chat", () => {
	expect(loadConfig({}, { WATCHER_S1_URL: "http://mac:8900/v1/" })).toMatchObject({ api: "cascade", s1Url: "http://mac:8900/v1", s1Threshold: 0.3, threshold: 0.9 });
	expect(loadConfig({}, {}).api).toBe("chat");
	expect(loadConfig({ OMP_STRATA_WATCHER_API: "cascade" }, {}).api).toBe("chat");
	expect(loadConfig({ OMP_STRATA_WATCHER_API: "chat" }, { WATCHER_S1_URL: "http://mac:8900/v1" }).api).toBe("chat");
});
