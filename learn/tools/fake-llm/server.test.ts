// 假模型服务器自己的测试。运行：node --test learn/tools/fake-llm/
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type FakeLlmServer, startFakeLlm } from "./server.ts";

const TOOLS_OPENAI = [
	{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
	{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
	{ type: "function", function: { name: "ls", parameters: { type: "object", properties: { path: { type: "string" } } } } },
	{ type: "function", function: { name: "get_current_time", parameters: { type: "object", properties: {} } } },
	{
		type: "function",
		function: { name: "calculate", parameters: { type: "object", properties: { expression: { type: "string" } } } },
	},
];

async function openai(server: FakeLlmServer, body: object, key = "fake") {
	const res = await fetch(`${server.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as any };
}

/** 读取一个 SSE 响应的所有 data 行 */
async function sseData(res: Response): Promise<string[]> {
	const text = await res.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice(6));
}

describe("fake-llm server", () => {
	let server: FakeLlmServer;
	before(async () => {
		server = await startFakeLlm({ port: 0, delayMs: 0 });
	});
	after(async () => {
		await server.close();
	});

	test("没有 API key 返回 401", async () => {
		const { status, json } = await openai(server, { model: "m", messages: [] }, "");
		assert.equal(status, 401);
		assert.match(json.error.message, /API key/);
	});

	test("echo：复读并报告消息数量", async () => {
		const { json } = await openai(server, {
			model: "m",
			messages: [
				{ role: "system", content: "你是助手" },
				{ role: "user", content: "你好" },
			],
		});
		const content = json.choices[0].message.content as string;
		assert.match(content, /你好/);
		assert.match(content, /1 条消息/);
		assert.match(content, /系统提示词/);
		assert.equal(json.choices[0].finish_reason, "stop");
		assert.ok(json.usage.prompt_tokens > 0);
	});

	test("rules：'运行 ls -la' 调用 bash 而不是 ls", async () => {
		const { json } = await openai(server, {
			model: "m",
			messages: [{ role: "user", content: "运行 ls -la" }],
			tools: TOOLS_OPENAI,
		});
		const call = json.choices[0].message.tool_calls[0];
		assert.equal(call.function.name, "bash");
		assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls -la" });
		assert.equal(json.choices[0].finish_reason, "tool_calls");
	});

	test("rules：'然后' 表示多步，收到结果后继续下一步，最后总结", async () => {
		const tools = TOOLS_OPENAI;
		const first = await openai(server, {
			model: "m",
			messages: [{ role: "user", content: "读取 package.json 然后 运行 node --version" }],
			tools,
		});
		const call1 = first.json.choices[0].message.tool_calls[0];
		assert.equal(call1.function.name, "read");

		const history: any[] = [
			{ role: "user", content: "读取 package.json 然后 运行 node --version" },
			{ role: "assistant", content: null, tool_calls: [call1] },
			{ role: "tool", tool_call_id: call1.id, content: '{"name":"demo"}' },
		];
		const second = await openai(server, { model: "m", messages: history, tools });
		const call2 = second.json.choices[0].message.tool_calls[0];
		assert.equal(call2.function.name, "bash");

		history.push({ role: "assistant", content: null, tool_calls: [call2] });
		history.push({ role: "tool", tool_call_id: call2.id, content: "v22.0.0" });
		const third = await openai(server, { model: "m", messages: history, tools });
		assert.equal(third.json.choices[0].finish_reason, "stop");
		assert.match(third.json.choices[0].message.content, /2 个工具调用/);
		assert.match(third.json.choices[0].message.content, /v22\.0\.0/);
	});

	test("rules：'同时' 表示一次回复里并行调用多个工具", async () => {
		const { json } = await openai(server, {
			model: "m",
			messages: [{ role: "user", content: "现在几点 同时 计算 23*47" }],
			tools: TOOLS_OPENAI,
		});
		const names = json.choices[0].message.tool_calls.map((c: any) => c.function.name);
		assert.deepEqual(names, ["get_current_time", "calculate"]);
	});

	test("OpenAI 流式：内容片段拼起来等于完整回复，最后是 [DONE]", async () => {
		const res = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer fake" },
			body: JSON.stringify({
				model: "m",
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "讲个笑话" }],
			}),
		});
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
		const data = await sseData(res);
		assert.equal(data.at(-1), "[DONE]");
		const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
		const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
		assert.match(text, /讲个笑话/);
		assert.ok(chunks.at(-1).usage, "include_usage 时最后一个块带 usage");
	});

	test("Anthropic 流式：工具参数分片拼起来是合法 JSON", async () => {
		const res = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: { "x-api-key": "fake" },
			body: JSON.stringify({
				model: "m",
				max_tokens: 100,
				stream: true,
				messages: [{ role: "user", content: "读取 README.md" }],
				tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
			}),
		});
		const events = (await sseData(res)).map((d) => JSON.parse(d));
		const json = events
			.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta")
			.map((e) => e.delta.partial_json)
			.join("");
		assert.deepEqual(JSON.parse(json), { path: "README.md" });
		const stop = events.find((e) => e.type === "message_delta");
		assert.equal(stop.delta.stop_reason, "tool_use");
	});

	test("Anthropic：缺少 max_tokens 返回 400", async () => {
		const res = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: { "x-api-key": "fake" },
			body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as any;
		assert.equal(json.type, "error");
	});

	test("记录请求，方便测试检查客户端发送的内容", async () => {
		const before = server.requests.length;
		await openai(server, { model: "check-model", messages: [{ role: "user", content: "hi" }] });
		const recorded = server.requests[before];
		assert.equal(recorded.normalized.model, "check-model");
		assert.equal(recorded.api, "openai");
	});
});

describe("fake-llm script 模式", () => {
	test("按顺序返回剧本，用完后返回 500", async () => {
		const server = await startFakeLlm({
			port: 0,
			delayMs: 0,
			script: [{ text: "第一条" }, { toolCalls: [{ name: "bash", arguments: { command: "ls" } }] }],
		});
		try {
			const a = await openai(server, { model: "m", messages: [{ role: "user", content: "x" }] });
			assert.equal(a.json.choices[0].message.content, "第一条");
			const b = await openai(server, { model: "m", messages: [{ role: "user", content: "x" }] });
			assert.equal(b.json.choices[0].message.tool_calls[0].function.name, "bash");
			const c = await openai(server, { model: "m", messages: [{ role: "user", content: "x" }] });
			assert.equal(c.status, 500);
		} finally {
			await server.close();
		}
	});

	test("剧本里的 error 会变成 HTTP 错误", async () => {
		const server = await startFakeLlm({
			port: 0,
			delayMs: 0,
			script: [{ error: { status: 429, message: "Too many requests", type: "rate_limit_error" } }],
		});
		try {
			const a = await openai(server, { model: "m", messages: [{ role: "user", content: "x" }] });
			assert.equal(a.status, 429);
			assert.equal(a.json.error.type, "rate_limit_error");
		} finally {
			await server.close();
		}
	});

	test("contextWindow：超过上下文窗口返回 context_length_exceeded", async () => {
		const server = await startFakeLlm({ port: 0, delayMs: 0, contextWindow: 10 });
		try {
			const a = await openai(server, { model: "m", messages: [{ role: "user", content: "x".repeat(200) }] });
			assert.equal(a.status, 400);
			assert.equal(a.json.error.code, "context_length_exceeded");
		} finally {
			await server.close();
		}
	});
});

describe("fake-llm chop 模式", () => {
	test("碎片拼起来仍然是完整、合法的 SSE", async () => {
		const server = await startFakeLlm({ port: 0, delayMs: 0, chop: true, script: [{ text: "你好，世界！这是一段会被切碎的中文。" }] });
		try {
			const res = await fetch(`${server.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer fake" },
				body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
			});
			let pieces = 0;
			const decoder = new TextDecoder();
			let text = "";
			for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
				pieces++;
				text += decoder.decode(chunk, { stream: true });
			}
			text += decoder.decode();
			assert.ok(pieces > 10, `应该被切成很多块，实际 ${pieces} 块`);
			const content = text
				.split("\n")
				.filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
				.map((line) => JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? "")
				.join("");
			assert.equal(content, "你好，世界！这是一段会被切碎的中文。");
		} finally {
			await server.close();
		}
	});
});
