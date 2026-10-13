import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createEmptyUsage,
	type Model,
	stream,
	type Tool,
	type ToolCall,
} from "../src/ai/index.ts";
import { type FakeServer, finishChunk, startFakeServer, textChunk, toolCallChunk } from "./helpers/fake-server.ts";

const servers: FakeServer[] = [];
after(async () => {
	for (const server of servers) await server.close();
});

async function serve(...responses: Parameters<typeof startFakeServer>[0]) {
	const server = await startFakeServer(responses);
	servers.push(server);
	return { ...server, baseUrl: `${server.url}/v1` };
}

function makeModel(baseUrl: string, id = "test-model"): Model {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl,
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const readTool: Tool = {
	name: "read",
	description: "读取文件",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

function assistant(content: AssistantMessage["content"], model = "test-model"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model,
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const all: AssistantMessageEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

test("工具调用：参数分段到达，拼起来后解析成对象", async () => {
	const server = await serve({
		chunks: [
			textChunk("我来读取。"),
			toolCallChunk(0, { id: "call_1", name: "read", args: "" }),
			toolCallChunk(0, { args: '{"path":' }),
			toolCallChunk(0, { args: ' "a.txt"}' }),
			finishChunk("tool_calls"),
		],
	});
	const response = stream(makeModel(server.baseUrl), { messages: [user("读 a.txt")], tools: [readTool] });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		[
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		],
	);
	const message = await response.result();
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content[1], { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } });
	const end = events.find((e) => e.type === "toolcall_end");
	assert.equal(end?.type === "toolcall_end" ? end.toolCall.name : "", "read");
});

test("一次回复里的两个工具调用（按 index 区分）", async () => {
	const server = await serve({
		chunks: [
			toolCallChunk(0, { id: "call_a", name: "read", args: '{"path":"a.txt"}' }),
			toolCallChunk(1, { id: "call_b", name: "read", args: '{"path":"b.txt"}' }),
			finishChunk("tool_calls"),
		],
	});
	const message = await stream(makeModel(server.baseUrl), { messages: [user("?")], tools: [readTool] }).result();
	const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	assert.deepEqual(
		calls.map((call) => [call.id, call.arguments.path]),
		[
			["call_a", "a.txt"],
			["call_b", "b.txt"],
		],
	);
});

test("有的服务商调用工具时 finish_reason 是 stop，也算作 toolUse", async () => {
	const server = await serve({
		chunks: [toolCallChunk(0, { id: "c", name: "read", args: '{"path":"a"}' }), finishChunk("stop")],
	});
	const message = await stream(makeModel(server.baseUrl), { messages: [user("?")], tools: [readTool] }).result();
	assert.equal(message.stopReason, "toolUse");
});

test("请求里带上 OpenAI 格式的工具定义", async () => {
	const server = await serve({ chunks: [textChunk("ok"), finishChunk("stop")] });
	await stream(makeModel(server.baseUrl), { messages: [user("?")], tools: [readTool] }).result();
	assert.deepEqual(server.requests[0].body.tools, [
		{
			type: "function",
			function: { name: "read", description: "读取文件", parameters: readTool.parameters },
		},
	]);
});

test("工具调用和工具结果的翻译", async () => {
	const server = await serve({ chunks: [textChunk("ok"), finishChunk("stop")] });
	await stream(makeModel(server.baseUrl), {
		messages: [
			user("读 a.txt"),
			assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "文件内容" }],
				isError: false,
				timestamp: 0,
			},
		],
		tools: [readTool],
	}).result();
	assert.deepEqual(server.requests[0].body.messages.slice(1), [
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
		},
		{ role: "tool", tool_call_id: "call_1", content: "文件内容" },
	]);
});

test("思考内容：只发回当前这一轮、同一个模型生成的", async () => {
	const server = await serve({ chunks: [textChunk("ok"), finishChunk("stop")] });
	const thinking = (text: string) => ({ type: "thinking" as const, thinking: text, signature: "reasoning_content" });
	await stream(makeModel(server.baseUrl), {
		messages: [
			user("第一个问题"),
			assistant([thinking("上一轮的思考"), { type: "text", text: "上一轮的回答" }]),
			user("第二个问题"),
			assistant([thinking("这一轮的思考"), { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }]),
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: 0 },
			assistant(
				[thinking("别的模型的思考"), { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } }],
				"other-model",
			),
			{ role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "y" }], isError: false, timestamp: 0 },
		],
		tools: [readTool],
	}).result();
	const sent = server.requests[0].body.messages.filter((m: { role: string }) => m.role === "assistant");
	assert.equal(sent[0].reasoning_content, undefined, "上一轮的思考不发回");
	assert.equal(sent[1].reasoning_content, "这一轮的思考", "当前这一轮的思考要发回");
	assert.equal(sent[2].reasoning_content, undefined, "别的模型的思考不发回");
});
