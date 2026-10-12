import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createWriteTool, withFileMutationQueue } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

test("写入新文件，自动创建父目录", async (t) => {
	const dir = await makeTempDir(t);
	const result = await createWriteTool(dir).execute("id", { path: "src/deep/a.ts", content: "export {};\n" });
	assert.equal(result.content[0].text, "已写入 src/deep/a.ts");
	assert.equal(await readFile(join(dir, "src/deep/a.ts"), "utf-8"), "export {};\n");
});

test("覆盖已有的文件", async (t) => {
	const dir = await makeTempDir(t);
	const tool = createWriteTool(dir);
	await tool.execute("id", { path: "a.txt", content: "旧内容" });
	await tool.execute("id", { path: "a.txt", content: "新内容" });
	assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "新内容");
});

test("已经取消时不写入", async (t) => {
	const dir = await makeTempDir(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(createWriteTool(dir).execute("id", { path: "a.txt", content: "x" }, controller.signal), /取消/);
	await assert.rejects(readFile(join(dir, "a.txt")));
});

test("文件修改队列：同一个文件的操作排队，不同文件的操作同时进行", async () => {
	const log: string[] = [];
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const operation = (name: string, ms: number) => async () => {
		log.push(`${name} 开始`);
		await sleep(ms);
		log.push(`${name} 结束`);
	};
	await Promise.all([
		withFileMutationQueue("/tmp/same.txt", operation("A", 30)),
		withFileMutationQueue("/tmp/same.txt", operation("B", 1)),
		withFileMutationQueue("/tmp/other.txt", operation("C", 1)),
	]);
	assert.ok(log.indexOf("B 开始") > log.indexOf("A 结束"), "B 等 A 结束才开始");
	assert.ok(log.indexOf("C 结束") < log.indexOf("A 结束"), "C 不用等");
});

test("文件修改队列：前一个操作失败，后面的操作照样执行", async () => {
	const failing = withFileMutationQueue("/tmp/x.txt", async () => {
		throw new Error("失败了");
	});
	const next = withFileMutationQueue("/tmp/x.txt", async () => "成功");
	await assert.rejects(failing, /失败了/);
	assert.equal(await next, "成功");
});
