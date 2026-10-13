import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type AssistantMessage, createEmptyUsage, type Model, stream, type Tool } from "../src/ai/index.ts";
import {
	blockDelta,
	blockStart,
	blockStop,
	type FakeServer,
	messageDelta,
	messageStart,
	startFakeServer,
} from "./helpers/fake-server.ts";

const servers: FakeServer[] = [];
after(async () => {
	for (const server of servers) await server.close();
});

async function serve(...responses: Parameters<typeof startFakeServer>[0]) {
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
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const readTool: Tool = {
	name: "read",
	description: "读取文件",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(id: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 0,
	};
}

const okResponse = {
	events: [messageStart(), blockStart(0, { type: "text", text: "" }), blockStop(0), messageDelta("end_turn", 1)],
};

test("tool_use 块：input_json_delta 拼起来解析成参数", async () => {
	const server = await serve({
		events: [
			messageStart(),
			blockStart(0, { type: "tool_use", id: "toolu_1", name: "read", input: {} }),
			blockDelta(0, { type: "input_json_delta", partial_json: '{"pa' }),
			blockDelta(0, { type: "input_json_delta", partial_json: 'th": "a.txt"}' }),
			blockStop(0),
			messageDelta("tool_use", 20),
		],
	});
	const response = stream(makeModel(server.url), { messages: [user("读 a.txt")], tools: [readTool] });
	const types: string[] = [];
	for await (const event of response) types.push(event.type);
	assert.deepEqual(types, ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
	const message = await response.result();
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } }]);
});

test("请求里的工具定义使用 input_schema", async () => {
	const server = await serve(okResponse);
	await stream(makeModel(server.url), { messages: [user("?")], tools: [readTool] }).result();
	assert.deepEqual(server.requests[0].body.tools, [
		{ name: "read", description: "读取文件", input_schema: readTool.parameters },
	]);
});

test("多个工具结果放进同一条 user 消息", async () => {
	const server = await serve(okResponse);
	await stream(makeModel(server.url), {
		messages: [
			user("读 a 和 b"),
			assistant([
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
			]),
			toolResult("t1", "内容 a"),
			toolResult("t2", "内容 b"),
		],
		tools: [readTool],
	}).result();
	assert.deepEqual(server.requests[0].body.messages, [
		{ role: "user", content: "读 a 和 b" },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
				{ type: "tool_use", id: "t2", name: "read", input: { path: "b" } },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: "内容 a", is_error: false },
				{ type: "tool_result", tool_use_id: "t2", content: "内容 b", is_error: false },
			],
		},
	]);
});

test("思考块：当前这一轮的连同签名发回，之前几轮的和没有签名的不发回", async () => {
	const server = await serve(okResponse);
	await stream(makeModel(server.url), {
		messages: [
			user("第一个问题"),
			assistant([
				{ type: "thinking", thinking: "上一轮", signature: "sig-old" },
				{ type: "text", text: "回答" },
			]),
			user("第二个问题"),
			assistant([
				{ type: "thinking", thinking: "这一轮", signature: "sig-new" },
				{ type: "thinking", thinking: "没有签名" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
			]),
			toolResult("t1", "内容"),
		],
		tools: [readTool],
	}).result();
	const messages = server.requests[0].body.messages;
	assert.deepEqual(messages[1].content, [{ type: "text", text: "回答" }]);
	assert.deepEqual(messages[3].content, [
		{ type: "thinking", thinking: "这一轮", signature: "sig-new" },
		{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
	]);
});
