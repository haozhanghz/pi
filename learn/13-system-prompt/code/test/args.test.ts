import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "../src/cli/args.ts";

test("没有参数：交互模式的默认值", () => {
	const args = parseCliArgs([]);
	assert.equal(args.print, false);
	assert.equal(args.mode, "text");
	assert.deepEqual(args.messages, []);
	assert.deepEqual(args.appendSystemPrompt, []);
});

test("-p、消息、@文件", () => {
	const args = parseCliArgs(["-p", "@src/a.ts", "解释一下", "@b.ts", "第二条"]);
	assert.equal(args.print, true);
	assert.deepEqual(args.fileArgs, ["src/a.ts", "b.ts"]);
	assert.deepEqual(args.messages, ["解释一下", "第二条"]);
});

test("--model、--tools、--no-tools、--append-system-prompt 可以用多次", () => {
	const args = parseCliArgs([
		"-m",
		"deepseek/deepseek-chat",
		"--tools",
		"read, ls",
		"--append-system-prompt",
		"a",
		"--append-system-prompt",
		"b",
	]);
	assert.equal(args.model, "deepseek/deepseek-chat");
	assert.deepEqual(args.tools, ["read", "ls"]);
	assert.deepEqual(args.appendSystemPrompt, ["a", "b"]);
	assert.equal(parseCliArgs(["--no-tools"]).noTools, true);
});

test("--mode json 也表示 print 模式", () => {
	const args = parseCliArgs(["--mode", "json", "你好"]);
	assert.equal(args.print, true);
	assert.equal(args.mode, "json");
});

test("不认识的参数、不合法的 --mode：报错", () => {
	assert.throws(() => parseCliArgs(["--bogus"]), /--bogus[\s\S]*--help/);
	assert.throws(() => parseCliArgs(["--mode", "xml"]), /--mode 只能是 text 或 json/);
});
