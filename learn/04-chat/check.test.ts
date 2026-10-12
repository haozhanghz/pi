// 检查 chat.ts 是否正确。
//   检查参考答案：     node --test learn/04-chat/check.test.ts
//   检查你自己的项目： MY_PI=~/my-pi node --test learn/04-chat/check.test.ts
// 检查脚本通过"标准输入"模拟用户一行一行地打字。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { projectDir, runNode } from "../tools/check-helpers.ts";
import { type FakeLlmServer, startFakeLlm } from "../tools/fake-llm/server.ts";

const cwd = projectDir(import.meta.dirname);
let server: FakeLlmServer;

before(async () => {
	server = await startFakeLlm({ port: 0, delayMs: 0, script: [] });
});
after(async () => {
	await server.close();
});

function env(): Record<string, string> {
	return { LLM_BASE_URL: `${server.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "test-model" };
}

type Msg = { role: string; content: string };

function messagesOf(index: number): Msg[] {
	const request = server.requests[index];
	assert.ok(request, `假模型服务器没有收到第 ${index + 1} 个请求`);
	return request.body.messages as Msg[];
}

test("每次请求都带上完整的历史", async () => {
	server.setScript([{ text: "你好，小明！" }, { text: "你叫小明。" }]);
	const start = server.requests.length;
	const result = await runNode(cwd, "playground/chat.ts", [], env(), { input: "我叫小明\n我叫什么？\n/exit\n" });
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /你好，小明！/);
	assert.match(result.stdout, /你叫小明。/);

	const second = messagesOf(start + 1).filter((m) => m.role !== "system");
	assert.deepEqual(
		second.map((m) => [m.role, m.content]),
		[
			["user", "我叫小明"],
			["assistant", "你好，小明！"],
			["user", "我叫什么？"],
		],
		"第二次请求应该包含：第一句、模型的回答、第二句",
	);
});

test("第一条消息是系统提示词", async () => {
	server.setScript([{ text: "嗯" }]);
	const start = server.requests.length;
	await runNode(cwd, "playground/chat.ts", [], env(), { input: "hi\n/exit\n" });
	assert.equal(messagesOf(start)[0].role, "system");
});

test("/reset 之后，模型收不到之前的对话", async () => {
	server.setScript([{ text: "第一句的回答" }, { text: "重置后的回答" }]);
	const start = server.requests.length;
	await runNode(cwd, "playground/chat.ts", [], env(), { input: "第一句\n/reset\n第二句\n/exit\n" });
	const afterReset = messagesOf(start + 1).filter((m) => m.role !== "system");
	assert.deepEqual(
		afterReset.map((m) => m.content),
		["第二句"],
	);
});

test("请求失败时撤回那条用户消息，程序继续运行", async () => {
	server.setScript([{ error: { status: 500, message: "服务器开小差了" } }, { text: "这次成功了" }]);
	const start = server.requests.length;
	const result = await runNode(cwd, "playground/chat.ts", [], env(), { input: "会失败的问题\n新的问题\n/exit\n" });
	assert.equal(result.code, 0, "一次请求失败不应该让程序退出");
	assert.match(result.stdout + result.stderr, /500/);
	assert.match(result.stdout, /这次成功了/);
	const retry = messagesOf(start + 1).filter((m) => m.role !== "system");
	assert.deepEqual(
		retry.map((m) => m.content),
		["新的问题"],
		"失败的那条用户消息应该被撤回",
	);
});

test("输入结束（Ctrl+D）时正常退出", async () => {
	server.setScript([{ text: "好" }]);
	const result = await runNode(cwd, "playground/chat.ts", [], env(), { input: "你好\n" });
	assert.equal(result.code, 0);
});

test("空行不会发送请求", async () => {
	server.setScript([{ text: "好" }]);
	const start = server.requests.length;
	await runNode(cwd, "playground/chat.ts", [], env(), { input: "\n   \n你好\n/exit\n" });
	assert.equal(server.requests.length - start, 1);
});
