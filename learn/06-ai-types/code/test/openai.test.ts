import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type AssistantMessageEvent, createEmptyUsage, type Model, stream } from "../src/ai/index.ts";
import {
	type FakeServer,
	finishChunk,
	reasoningChunk,
	startFakeOpenAIServer,
	textChunk,
	usageChunk,
} from "./helpers/fake-openai-server.ts";

const servers: FakeServer[] = [];
after(async () => {
	for (const server of servers) await server.close();
});

async function serve(...responses: Parameters<typeof startFakeOpenAIServer>[0]) {
	const server = await startFakeOpenAIServer(responses);
	servers.push(server);
	return server;
}

function makeModel(baseUrl: string): Model {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl,
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8192,
		// 每百万 token：输入 2 美元，输出 8 美元，缓存命中 0.5 美元
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
	};
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const all: AssistantMessageEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

test("文字回复：事件顺序是 start → text_start → text_delta… → text_end → done", async () => {
	const server = await serve({
		chunks: [textChunk("你"), textChunk("好"), finishChunk("stop"), usageChunk(10, 2)],
	});
	const response = stream(
		makeModel(server.baseUrl),
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "k" },
	);
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	const message = await response.result();
	assert.deepEqual(message.content, [{ type: "text", text: "你好" }]);
	assert.equal(message.stopReason, "stop");
	assert.equal(message.usage.input, 10);
	assert.equal(message.usage.output, 2);
	// 10 * 2 / 1e6 + 2 * 8 / 1e6
	assert.ok(Math.abs(message.usage.cost.total - 0.000036) < 1e-12);
});

test("请求格式：地址、key、系统提示词、stream: true", async () => {
	const server = await serve({ chunks: [textChunk("ok"), finishChunk("stop")] });
	await stream(
		makeModel(server.baseUrl),
		{ systemPrompt: "你是助手", messages: [{ role: "user", content: "你好", timestamp: 0 }] },
		{ apiKey: "secret", maxTokens: 100 },
	).result();
	const request = server.requests[0];
	assert.equal(request.path, "/v1/chat/completions");
	assert.equal(request.headers.authorization, "Bearer secret");
	assert.equal(request.body.model, "test-model");
	assert.equal(request.body.stream, true);
	assert.equal(request.body.max_tokens, 100);
	assert.deepEqual(request.body.messages, [
		{ role: "system", content: "你是助手" },
		{ role: "user", content: "你好" },
	]);
});

test("思考内容：先 thinking 块再 text 块，并记录来源字段", async () => {
	const server = await serve({
		chunks: [reasoningChunk("想"), reasoningChunk("想看"), textChunk("答案"), finishChunk("stop")],
	});
	const response = stream(makeModel(server.baseUrl), { messages: [{ role: "user", content: "?", timestamp: 0 }] });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		[
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		],
	);
	const message = await response.result();
	assert.deepEqual(message.content, [
		{ type: "thinking", thinking: "想想看", signature: "reasoning_content" },
		{ type: "text", text: "答案" },
	]);
});

test("历史里的思考内容不会发回去，只发文字", async () => {
	const server = await serve({ chunks: [textChunk("ok"), finishChunk("stop")] });
	const model = makeModel(server.baseUrl);
	await stream(model, {
		messages: [
			{ role: "user", content: "问题", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "思考过程", signature: "reasoning_content" },
					{ type: "text", text: "回答" },
				],
				api: "openai-completions",
				provider: "test",
				model: "test-model",
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "再问", timestamp: 0 },
		],
	}).result();
	assert.deepEqual(server.requests[0].body.messages[1], { role: "assistant", content: "回答" });
});

test("finish_reason 为 length 时，stopReason 是 length", async () => {
	const server = await serve({ chunks: [textChunk("半截"), finishChunk("length")] });
	const message = await stream(makeModel(server.baseUrl), {
		messages: [{ role: "user", content: "?", timestamp: 0 }],
	}).result();
	assert.equal(message.stopReason, "length");
});

test("HTTP 错误不会抛异常，而是变成 error 事件，并带上服务商的错误信息", async () => {
	const server = await serve({ status: 401, body: '{"error":{"message":"Invalid API key"}}' });
	const response = stream(makeModel(server.baseUrl), { messages: [{ role: "user", content: "?", timestamp: 0 }] });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		["error"],
	);
	const message = await response.result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /401/);
	assert.match(message.errorMessage ?? "", /Invalid API key/);
});

test("连不上服务器也不会抛异常", async () => {
	const message = await stream(makeModel("http://127.0.0.1:1/v1"), {
		messages: [{ role: "user", content: "?", timestamp: 0 }],
	}).result();
	assert.equal(message.stopReason, "error");
	assert.ok(message.errorMessage);
});

test("没有 finish_reason 就结束了，算作错误（连接可能中断）", async () => {
	const server = await serve({ chunks: [textChunk("说到一半")], done: false });
	const message = await stream(makeModel(server.baseUrl), {
		messages: [{ role: "user", content: "?", timestamp: 0 }],
	}).result();
	assert.equal(message.stopReason, "error");
	assert.deepEqual(message.content, [{ type: "text", text: "说到一半" }], "已经收到的内容要保留");
});

test("取消：stopReason 是 aborted，已收到的内容保留", async () => {
	const chunks = Array.from({ length: 50 }, (_, i) => textChunk(`${i} `));
	const server = await serve({ chunks: [...chunks, finishChunk("stop")], delayMs: 10 });
	const controller = new AbortController();
	const response = stream(
		makeModel(server.baseUrl),
		{ messages: [{ role: "user", content: "?", timestamp: 0 }] },
		{ signal: controller.signal },
	);
	let deltas = 0;
	for await (const event of response) {
		if (event.type === "text_delta") {
			deltas++;
			if (deltas === 3) controller.abort();
		}
	}
	const message = await response.result();
	assert.equal(message.stopReason, "aborted");
	const text = message.content[0]?.type === "text" ? message.content[0].text : "";
	assert.ok(text.startsWith("0 1 2"), `已收到的内容应该保留，实际：${text}`);
});
