import { expect, test } from "bun:test";
import { buildPin, promptText } from "../agent/extensions/handoff-speed.ts";

const branch = [
	{ type: "mode_change", data: { goal: { id: "g", objective: "Fix (1) and (2). Keep :8201 up.", status: "active" } } },
	{ type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "init", phases: [{ name: "P", tasks: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "three", status: "pending" }] }] } } },
	{ type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "view", phases: [] } } },
];
const rules = "Caveman lite. Terse.\n\nGit: commit each change.";

test("goal, current item, and rules when the system prompt lacks them", () => {
	const pin = buildPin(branch, rules, "a prompt without them");
	expect(pin?.text).toContain("Goal (verbatim): Fix (1) and (2). Keep :8201 up.");
	expect(pin?.text).toContain("Current item: two (P). Open items: 2.");
	expect(pin?.text).toContain("Git: commit each change.");
	expect(pin?.fields.rules).toBe("pinned");
});
test("rules already in the system prompt are not repeated", () => {
	const pin = buildPin(branch, rules, `x\n<generic-rules>\n${rules}\n</generic-rules>`);
	expect(pin?.text).not.toContain("Git: commit");
	expect(pin?.fields.rules).toBe("in system prompt");
});
test("a completed goal is not pinned; nothing to pin gives undefined", () => {
	const done = [{ type: "mode_change", data: { goal: { objective: "x", status: "complete" } } }];
	expect(buildPin(done, undefined, "")).toBeUndefined();
});
test("long objectives are cut", () => {
	const long = [{ type: "mode_change", data: { goal: { objective: "y".repeat(5000), status: "active" } } }];
	expect(buildPin(long, undefined, "")!.text.length).toBeLessThan(1700);
});
test("promptText flattens arrays of parts", () => {
	expect(promptText(["a", { text: "b" }, { type: "text", text: "c" }])).toBe("a\nb\nc");
	expect(promptText(undefined)).toBeUndefined();
});
