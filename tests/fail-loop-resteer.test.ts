import { expect, test } from "bun:test";
import { stripTaskModel, addImageReadHint } from "../agent/extensions/fail-loop-resteer.ts";

test("stripTaskModel returns undefined for undefined", () => {
	expect(stripTaskModel(undefined)).toBeUndefined();
});

test("stripTaskModel returns undefined for a string", () => {
	expect(stripTaskModel("not an object")).toBeUndefined();
});

test("stripTaskModel returns undefined when there is no model to strip", () => {
	expect(stripTaskModel({ tasks: [{ task: "x" }] })).toBeUndefined();
});

test("stripTaskModel removes top-level model key", () => {
	const input = { model: "m", agent: "a" };
	const result = stripTaskModel(input);
	expect(result).toEqual({ agent: "a" });
});

test("stripTaskModel removes per-task model keys", () => {
	const input = { tasks: [{ task: "x", model: "m" }, { task: "y" }] };
	const result = stripTaskModel(input);
	expect(result).toEqual({ tasks: [{ task: "x" }, { task: "y" }] });
});

test("stripTaskModel removes both top-level and per-task model keys", () => {
	const input = { model: "top", tasks: [{ task: "x", model: "inner" }, { task: "y" }] };
	const result = stripTaskModel(input);
	expect(result).toEqual({ tasks: [{ task: "x" }, { task: "y" }] });
});

test("addImageReadHint returns undefined when there is no tasks array", () => {
	expect(addImageReadHint({})).toBeUndefined();
	expect(addImageReadHint(undefined)).toBeUndefined();
	expect(addImageReadHint("not an object")).toBeUndefined();
});

test("addImageReadHint returns undefined when no task text has an image path", () => {
	const input = { tasks: [{ task: "do something" }, { task: "do another" }] };
	expect(addImageReadHint(input)).toBeUndefined();
});

test("addImageReadHint appends read hint for image paths and lists both paths", () => {
	const input = { tasks: [{ task: "check /tmp/a.png and ./b.jpg" }] };
	const result = addImageReadHint(input);
	expect(result).not.toBeUndefined();
	const taskText = (result as { tasks: Array<{ task: string }> }).tasks[0].task;
	expect(taskText.startsWith("check /tmp/a.png and ./b.jpg\n\n")).toBe(true);
	expect(taskText).toContain("read /tmp/a.png?q=<question>");
	expect(taskText).toContain("/tmp/a.png");
	expect(taskText).toContain("./b.jpg");
	expect(taskText).toContain("read <path>?q=<question>");
});

test("addImageReadHint deduplicates the same path listed twice in extracted paths", () => {
	const input = { tasks: [{ task: "check /tmp/a.png and /tmp/a.png" }] };
	const result = addImageReadHint(input);
	expect(result).not.toBeUndefined();
	const taskText = (result as { tasks: Array<{ task: string }> }).tasks[0].task;
	expect(taskText).toContain("Do not answer before reading each image: ");
	const listPart = taskText.split("Do not answer before reading each image: ")[1];
	expect(listPart).toContain("/tmp/a.png");
	expect(listPart.split("/tmp/a.png").length).toBe(2);
});

test("addImageReadHint returns undefined when task already contains the hint marker", () => {
	const input = { tasks: [{ task: "read <path>?q=<question>" }] };
	expect(addImageReadHint(input)).toBeUndefined();
});

test("addImageReadHint does not match .gif paths for hints", () => {
	const input = { tasks: [{ task: "check /tmp/anim.gif" }] };
	expect(addImageReadHint(input)).toBeUndefined();
});

test("addImageReadHint matches .png but not .gif in same text", () => {
	const input = { tasks: [{ task: "check /tmp/anim.gif and /tmp/frame.png" }] };
	const result = addImageReadHint(input);
	expect(result).not.toBeUndefined();
	const taskText = (result as { tasks: Array<{ task: string }> }).tasks[0].task;
	expect(taskText).toContain("/tmp/anim.gif");
	expect(taskText).toContain("/tmp/frame.png");
	expect(taskText).toContain("read /tmp/frame.png?q=<question>");
	expect(taskText).not.toContain("read /tmp/anim.gif?q=<question>");
	expect(taskText).toContain("Do not answer before reading each image: ");
	const listPart = taskText.split("Do not answer before reading each image: ")[1];
	expect(listPart).toContain("/tmp/frame.png");
	expect(listPart).not.toContain("/tmp/anim.gif");
});
