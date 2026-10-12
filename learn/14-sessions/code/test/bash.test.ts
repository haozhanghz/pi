import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentToolResult } from "../src/agent/index.ts";
import { type BashToolDetails, createBashTool } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

async function bash(cwd: string, command: string, timeout?: number): Promise<AgentToolResult> {
	return createBashTool(cwd).execute("id", { command, timeout });
}

const text = (result: AgentToolResult) => result.content[0].text;

test("执行命令，返回输出", async (t) => {
	const dir = await makeTempDir(t);
	const result = await bash(dir, "echo hello");
	assert.equal(text(result), "hello");
	assert.equal(result.isError, undefined);
	assert.equal((result.details as BashToolDetails).exitCode, 0);
});

test("标准错误也包含在输出里", async (t) => {
	const dir = await makeTempDir(t);
	const result = await bash(dir, "echo out; echo err 1>&2");
	assert.match(text(result), /out/);
	assert.match(text(result), /err/);
});

test("在 cwd 里执行", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "marker.txt"), "");
	assert.match(text(await bash(dir, "ls")), /marker\.txt/);
});

test("退出码不是 0：isError，输出后面加上退出码", async (t) => {
	const dir = await makeTempDir(t);
	const result = await bash(dir, "echo 出错了; exit 3");
	assert.equal(result.isError, true);
	assert.equal(text(result), "出错了\n\n命令的退出码是 3。");
});

test("没有输出", async (t) => {
	const dir = await makeTempDir(t);
	assert.equal(text(await bash(dir, "true")), "（没有输出）");
});

test("超时：终止命令，抛出异常", async (t) => {
	const dir = await makeTempDir(t);
	const started = Date.now();
	await assert.rejects(bash(dir, "echo 开始; sleep 5", 0.3), /开始[\s\S]*命令超时（0\.3 秒）/);
	assert.ok(Date.now() - started < 2000, "不用等 5 秒");
});

test("取消：终止命令", async (t) => {
	const dir = await makeTempDir(t);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const started = Date.now();
	await assert.rejects(createBashTool(dir).execute("id", { command: "sleep 5" }, controller.signal), /命令被取消了/);
	assert.ok(Date.now() - started < 2000);
});

test("取消时，命令启动的子进程也被终止", async (t) => {
	const dir = await makeTempDir(t);
	const controller = new AbortController();
	// 在后台启动一个子进程：每 50 毫秒往文件里写一行。它被终止后，文件就不再变大了
	const command = "(while true; do echo x >> heartbeat.txt; sleep 0.05; done) & echo 已启动; wait";
	const running = createBashTool(dir).execute("id", { command }, controller.signal, () => controller.abort());
	await assert.rejects(running, /取消/);

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const size = async () => (await stat(join(dir, "heartbeat.txt"))).size;
	await sleep(200);
	const before = await size();
	await sleep(300);
	assert.equal(await size(), before, "后台的子进程已经不再写文件了");
});

test("命令启动了后台进程：不用等后台进程结束", async (t) => {
	const dir = await makeTempDir(t);
	const started = Date.now();
	const result = await bash(dir, "echo 已启动; sleep 3 &");
	assert.match(text(result), /已启动/);
	assert.ok(Date.now() - started < 2000, "后台的 sleep 还拿着输出管道，但工具已经返回了");
});

test("输出太多：只保留最后 2000 行，并告诉模型完整的输出在哪里", async (t) => {
	const dir = await makeTempDir(t);
	const result = await bash(dir, "seq 1 5000");
	const details = result.details as BashToolDetails;
	assert.ok(details.fullOutputPath);
	const path = details.fullOutputPath;
	t.after(() => rm(path, { force: true }));
	assert.ok(text(result).startsWith("3001\n"));
	assert.match(text(result), /5000\n\n\[显示了第 3001-5000 行，共 5000 行。完整的输出：.*\]$/);
});

test("实时报告进度", async (t) => {
	const dir = await makeTempDir(t);
	const updates: string[] = [];
	await createBashTool(dir).execute("id", { command: "echo 第一步; sleep 0.3; echo 第二步" }, undefined, (update) =>
		updates.push(update.content[0].text),
	);
	assert.ok(updates.length > 0);
	assert.equal(updates[0], "第一步\n", "第二步还没输出时，就已经收到了第一步");
});

test("timeout 不合法", async (t) => {
	const dir = await makeTempDir(t);
	await assert.rejects(bash(dir, "true", -1), /timeout 必须是大于 0 的秒数/);
});
