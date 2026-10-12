// 检查流式聊天 chat-stream.ts 和 SSE 解析器 sse.ts。
//   检查参考答案：     node --test learn/05-streaming/check.test.ts
//   检查你自己的项目： MY_PI=~/my-pi node --test learn/05-streaming/check.test.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { projectDir, runNode, spawnNode } from "../tools/check-helpers.ts";
import { type FakeLlmServer, startFakeLlm } from "../tools/fake-llm/server.ts";

const cwd = projectDir(import.meta.dirname);
let server: FakeLlmServer;

before(async () => {
	// chop：把响应切成随机碎片，检验解析器能否正确拼接被切开的行和汉字
	server = await startFakeLlm({ port: 0, delayMs: 0, chop: true, script: [] });
});
after(async () => {
	await server.close();
});

function env(): Record<string, string> {
	return { LLM_BASE_URL: `${server.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "test-model" };
}

test("流式请求带上 stream: true", async () => {
	server.setScript([{ text: "好" }]);
	const start = server.requests.length;
	await runNode(cwd, "playground/chat-stream.ts", [], env(), { input: "你好\n/exit\n" });
	assert.equal(server.requests[start]?.body.stream, true);
});

test("响应被切成碎片时，仍然能完整、正确地显示中文", async () => {
	const answer = "床前明月光，疑是地上霜。举头望明月，低头思故乡。";
	server.setScript([{ text: answer }]);
	const result = await runNode(cwd, "playground/chat-stream.ts", [], env(), { input: "背一首诗\n/exit\n" });
	assert.equal(result.code, 0, result.stderr);
	assert.ok(result.stdout.includes(answer), `输出里应该包含完整的诗句。实际输出：\n${result.stdout}`);
	assert.ok(!result.stdout.includes("�"), "输出里出现了乱码字符（�），多字节字符被切开后没有正确解码");
});

test("流式回答也会进入历史，下一轮请求能带上它", async () => {
	server.setScript([{ text: "第一次的回答" }, { text: "第二次的回答" }]);
	const start = server.requests.length;
	await runNode(cwd, "playground/chat-stream.ts", [], env(), { input: "问题一\n问题二\n/exit\n" });
	const messages = server.requests[start + 1]?.body.messages as { role: string; content: string }[];
	const assistant = messages.find((m) => m.role === "assistant");
	assert.equal(assistant?.content, "第一次的回答");
});

test("思考过程（reasoning_content）不会被当成回答保存进历史", async () => {
	server.setScript([{ thinking: "让我想想……", text: "答案是 42" }, { text: "好的" }]);
	const start = server.requests.length;
	const result = await runNode(cwd, "playground/chat-stream.ts", [], env(), { input: "问题\n再问\n/exit\n" });
	assert.match(result.stdout, /答案是 42/);
	const messages = server.requests[start + 1]?.body.messages as { role: string; content: string }[];
	const assistant = messages.find((m) => m.role === "assistant");
	assert.equal(assistant?.content, "答案是 42");
});

test("回答过程中 Ctrl+C 只打断这一次回答，程序继续运行", async () => {
	const longText = "这是一段很长很长的回答。".repeat(40);
	server.setScript([{ text: longText, delayMs: 20 }, { text: "第二次正常回答" }]);
	const child = spawnNode(cwd, "playground/chat-stream.ts", [], env());
	try {
		await child.waitFor(/你>/);
		child.write("讲个很长的故事\n");
		await child.waitFor(/这是一段很长/); // 回答开始出现了
		child.signal("SIGINT");
		const afterInterrupt = child.stdout.length;
		await child.waitFor(/你>/, { fromIndex: afterInterrupt }); // 又回到了等待输入的状态
		assert.ok(!child.stdout.includes(longText), "回答应该被打断，而不是完整输出");
		child.write("第二个问题\n");
		await child.waitFor(/第二次正常回答/);
		child.write("/exit\n");
		child.end();
		assert.equal(await child.exited, 0);
	} finally {
		child.signal("SIGKILL");
	}
});
