// 检查 ask.ts 是否正确。
//   检查参考答案：     node --test learn/03-first-call/check.test.ts
//   检查你自己的项目： MY_PI=~/my-pi node --test learn/03-first-call/check.test.ts
// 你的项目里需要有 playground/ask.ts，并且按 README 的"接口约定"读取环境变量和命令行参数。
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

test("把模型的回答打印出来，退出码为 0", async () => {
	server.setScript([{ text: "因为瑞利散射。" }]);
	const result = await runNode(cwd, "playground/ask.ts", ["天空为什么是蓝色的？"], env());
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /因为瑞利散射。/);
});

test("请求格式正确：POST、带 key、包含 model 和 user 消息", async () => {
	server.setScript([{ text: "好的" }]);
	const before = server.requests.length;
	await runNode(cwd, "playground/ask.ts", ["你好", "世界"], env());
	const request = server.requests[before];
	assert.ok(request, "假模型服务器没有收到请求");
	assert.equal(request.headers.authorization, "Bearer test-key");
	assert.equal(request.body.model, "test-model");
	const messages = request.body.messages as { role: string; content: string }[];
	const user = messages.find((m) => m.role === "user");
	assert.equal(user?.content, "你好 世界", "多个命令行参数应该用空格连起来作为问题");
});

test("打印 token 用量", async () => {
	server.setScript([{ text: "好的" }]);
	const result = await runNode(cwd, "playground/ask.ts", ["测试"], env());
	assert.match(result.stdout, /\d+ tokens/);
});

test("HTTP 错误时打印状态码，退出码不为 0", async () => {
	server.setScript([{ error: { status: 401, message: "Invalid API key", type: "authentication_error" } }]);
	const result = await runNode(cwd, "playground/ask.ts", ["测试"], env());
	assert.notEqual(result.code, 0);
	assert.match(result.stdout + result.stderr, /401/);
});

test("没有提供问题时，提示用法并以非 0 退出", async () => {
	const result = await runNode(cwd, "playground/ask.ts", [], env());
	assert.notEqual(result.code, 0);
});

test("缺少环境变量时，给出提示并以非 0 退出", async () => {
	const result = await runNode(cwd, "playground/ask.ts", ["你好"], {});
	assert.notEqual(result.code, 0);
	assert.match(result.stdout + result.stderr, /LLM_/);
});
