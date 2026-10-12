import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/index.ts";
import { createFauxModel, type ToolResultMessage } from "../src/ai/index.ts";
import { createCodingTools } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

test("agent 用文件工具完成任务：写文件 → 修改 → 读取确认", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([
		{ text: "我先创建文件。", toolCalls: [{ name: "write", arguments: { path: "hello.js", content: 'console.log("hello");\n' } }] },
		{
			text: "改成中文。",
			toolCalls: [{ name: "edit", arguments: { path: "hello.js", edits: [{ oldText: '"hello"', newText: '"你好"' }] } }],
		},
		{ text: "确认一下。", toolCalls: [{ name: "read", arguments: { path: "hello.js" } }] },
		{ text: "完成了。" },
	]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("写一个打印你好的脚本");

	assert.equal(await readFile(join(dir, "hello.js"), "utf-8"), 'console.log("你好");\n');
	const results = agent.state.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
	assert.deepEqual(
		results.map((r) => [r.toolName, r.isError]),
		[
			["write", false],
			["edit", false],
			["read", false],
		],
	);
	assert.equal(results[2].content[0].text, 'console.log("你好");');
});

test("edit 失败时，错误信息发回给模型，模型改正后重试", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([
		{ toolCalls: [{ name: "write", arguments: { path: "a.txt", content: "abc abc" } }] },
		{ toolCalls: [{ name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "abc", newText: "x" }] } }] },
		{ toolCalls: [{ name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "abc abc", newText: "x abc" }] } }] },
		{ text: "改好了" },
	]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("把第一个 abc 改成 x");

	const failed = faux.requests[2].messages.at(-1) as ToolResultMessage;
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /出现了 2 次/, "模型在第三次请求时看到了错误原因");
	assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "x abc");
});

test("完整的编程循环：运行 → 看到错误 → 修改 → 再运行", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "add.js"), "export const add = (a, b) => a - b;\n");
	await writeFile(
		join(dir, "check.js"),
		'import { add } from "./add.js";\nif (add(1, 2) !== 3) { console.error("add(1, 2) 应该是 3"); process.exit(1); }\nconsole.log("通过");\n',
	);
	const faux = createFauxModel([
		{ text: "先运行检查。", toolCalls: [{ name: "bash", arguments: { command: "node check.js" } }] },
		{
			text: "add 写成了减法，改一下。",
			toolCalls: [{ name: "edit", arguments: { path: "add.js", edits: [{ oldText: "a - b", newText: "a + b" }] } }],
		},
		{ text: "再运行一次。", toolCalls: [{ name: "bash", arguments: { command: "node check.js" } }] },
		{ text: "修好了。" },
	]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("检查没通过，帮我修一下");

	const results = agent.state.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
	assert.equal(results[0].isError, true, "第一次运行失败");
	assert.match(results[0].content[0].text, /add\(1, 2\) 应该是 3[\s\S]*退出码是 1/);
	assert.equal(results[2].isError, false, "修改后再运行，通过了");
	assert.equal(results[2].content[0].text, "通过");
});
