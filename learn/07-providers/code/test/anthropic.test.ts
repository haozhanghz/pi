import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type AssistantMessageEvent, createEmptyUsage, type Model, stream } from "../src/ai/index.ts";
import {
	blockDelta,
	blockStart,
	blockStop,
	type FakeResponse,
	type FakeServer,
	messageDelta,
	messageStart,
	messageStop,
	startFakeServer,
} from "./helpers/fake-server.ts";

const servers: FakeServer[] = [];
after(async () => {
	for (const server of servers) await server.close();
});

async function serve(...responses: FakeResponse[]): Promise<FakeServer> {
	const server = await startFakeServer(responses);
	servers.push(server);
	return server;
}

function makeModel(baseUrl: string): Model {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 4096,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	};
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const all: AssistantMessageEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

test("文字回复：翻译成和 OpenAI 适配器一样的事件顺序", async () => {
	const server = await serve({
		events: [
			messageStart({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 }),
			{ event: "ping", data: { type: "ping" } },
			blockStart(0, { type: "text", text: "" }),
			blockDelta(0, { type: "text_delta", text: "你" }),
			blockDelta(0, { type: "text_delta", text: "好" }),
			blockStop(0),
			messageDelta("end_turn", 20),
			messageStop(),
		],
	});
	const response = stream(makeModel(server.url), { messages: [user("hi")] }, { apiKey: "k" });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	const message = await response.result();
	assert.deepEqual(message.content, [{ type: "text", text: "你好" }]);
	assert.equal(message.stopReason, "stop");
	assert.equal(message.usage.input, 100);
	assert.equal(message.usage.cacheRead, 1000);
	assert.equal(message.usage.output, 20);
	// 100*2 + 1000*0.2 + 20*10 = 600，再除以一百万
	assert.ok(Math.abs(message.usage.cost.total - 0.0006) < 1e-12);
});

test("请求格式：/v1/messages、x-api-key、anthropic-version、max_tokens、system", async () => {
	const server = await serve({
		events: [messageStart(), blockStart(0, { type: "text", text: "" }), blockStop(0), messageDelta("end_turn", 1)],
	});
	await stream(makeModel(server.url), { systemPrompt: "你是助手", messages: [user("你好")] }, { apiKey: "secret" }).result();
	const request = server.requests[0];
	assert.equal(request.path, "/v1/messages");
	assert.equal(request.headers["x-api-key"], "secret");
	assert.equal(request.headers["anthropic-version"], "2023-06-01");
	assert.equal(request.body.max_tokens, 4096, "没有指定 maxTokens 时，使用模型的 maxTokens");
	assert.equal(request.body.system, "你是助手");
	assert.equal(request.body.stream, true);
	assert.deepEqual(request.body.messages, [{ role: "user", content: "你好" }]);
	assert.equal(request.body.temperature, undefined, "没有设置时不能发送 temperature（新模型会拒绝）");
});

test("思考块：记录签名", async () => {
	const server = await serve({
		events: [
			messageStart(),
			blockStart(0, { type: "thinking", thinking: "" }),
			blockDelta(0, { type: "thinking_delta", thinking: "让我想想" }),
			blockDelta(0, { type: "signature_delta", signature: "sig-abc" }),
			blockStop(0),
			blockStart(1, { type: "text", text: "" }),
			blockDelta(1, { type: "text_delta", text: "答案" }),
			blockStop(1),
			messageDelta("end_turn", 5),
			messageStop(),
		],
	});
	const response = stream(makeModel(server.url), { messages: [user("?")] });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"],
	);
	const message = await response.result();
	assert.deepEqual(message.content, [
		{ type: "thinking", thinking: "让我想想", signature: "sig-abc" },
		{ type: "text", text: "答案" },
	]);
});

test("历史里的助手消息变成内容块数组，思考内容不发回", async () => {
	const server = await serve({
		events: [messageStart(), blockStart(0, { type: "text", text: "" }), blockStop(0), messageDelta("end_turn", 1)],
	});
	await stream(makeModel(server.url), {
		messages: [
			user("问题"),
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "思考", signature: "sig" },
					{ type: "text", text: "回答" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: 0,
			},
			user("再问"),
		],
	}).result();
	assert.deepEqual(server.requests[0].body.messages, [
		{ role: "user", content: "问题" },
		{ role: "assistant", content: [{ type: "text", text: "回答" }] },
		{ role: "user", content: "再问" },
	]);
});

test("stop_reason 为 max_tokens 时，stopReason 是 length", async () => {
	const server = await serve({
		events: [
			messageStart(),
			blockStart(0, { type: "text", text: "" }),
			blockDelta(0, { type: "text_delta", text: "半截" }),
			blockStop(0),
			messageDelta("max_tokens", 4096),
			messageStop(),
		],
	});
	const message = await stream(makeModel(server.url), { messages: [user("?")] }).result();
	assert.equal(message.stopReason, "length");
});

test("HTTP 错误：取出 Anthropic 格式的错误信息", async () => {
	const server = await serve({
		status: 529,
		body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	});
	const message = await stream(makeModel(server.url), { messages: [user("?")] }).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /529/);
	assert.match(message.errorMessage ?? "", /Overloaded/);
});

test("流中途收到 error 事件：以错误结束，已收到的内容保留", async () => {
	const server = await serve({
		events: [
			messageStart(),
			blockStart(0, { type: "text", text: "" }),
			blockDelta(0, { type: "text_delta", text: "说到一半" }),
			{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
		],
	});
	const message = await stream(makeModel(server.url), { messages: [user("?")] }).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /overloaded_error/);
	assert.deepEqual(message.content, [{ type: "text", text: "说到一半" }]);
});

test("没有 stop_reason 就结束了：算作错误", async () => {
	const server = await serve({
		events: [messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "x" })],
	});
	const message = await stream(makeModel(server.url), { messages: [user("?")] }).result();
	assert.equal(message.stopReason, "error");
});

test("不认识的内容块类型会被跳过", async () => {
	const server = await serve({
		events: [
			messageStart(),
			blockStart(0, { type: "some_future_block" }),
			blockDelta(0, { type: "some_future_delta" }),
			blockStop(0),
			blockStart(1, { type: "text", text: "" }),
			blockDelta(1, { type: "text_delta", text: "ok" }),
			blockStop(1),
			messageDelta("end_turn", 1),
		],
	});
	const message = await stream(makeModel(server.url), { messages: [user("?")] }).result();
	assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
});
