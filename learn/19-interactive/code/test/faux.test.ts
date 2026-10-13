import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessageEvent, createFauxModel, stream } from "../src/ai/index.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const all: AssistantMessageEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

test("按剧本顺序回复，事件和真实适配器一致", async () => {
	const faux = createFauxModel([{ text: "第一句回复" }, { thinking: "想一想", text: "第二句" }]);
	const first = stream(faux.model, { messages: [user("a")] });
	const events = await collect(first);
	assert.equal(events[0].type, "start");
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(
		events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e.type === "text_delta" ? e.delta : ""))
			.join(""),
		"第一句回复",
	);

	const second = await stream(faux.model, { messages: [user("b")] }).result();
	assert.deepEqual(second.content, [
		{ type: "thinking", thinking: "想一想" },
		{ type: "text", text: "第二句" },
	]);
	assert.equal(faux.remaining, 0);
});

test("记录收到的请求", async () => {
	const faux = createFauxModel([{ text: "好" }]);
	await stream(faux.model, { systemPrompt: "你是助手", messages: [user("你好")] }).result();
	assert.equal(faux.requests.length, 1);
	assert.equal(faux.requests[0].systemPrompt, "你是助手");
	assert.deepEqual(faux.requests[0].messages, [user("你好")]);
});

test("剧本的一步可以是函数，根据上下文决定回复", async () => {
	const faux = createFauxModel([(context) => ({ text: `你一共发了 ${context.messages.length} 条消息` })]);
	const message = await stream(faux.model, { messages: [user("a"), user("b")] }).result();
	assert.deepEqual(message.content, [{ type: "text", text: "你一共发了 2 条消息" }]);
});

test("模拟错误；剧本用完也会以错误结束", async () => {
	const faux = createFauxModel([{ error: "服务器开小差了" }]);
	const failed = await stream(faux.model, { messages: [user("a")] }).result();
	assert.equal(failed.stopReason, "error");
	assert.equal(failed.errorMessage, "服务器开小差了");
	const exhausted = await stream(faux.model, { messages: [user("a")] }).result();
	assert.equal(exhausted.stopReason, "error");
	assert.match(exhausted.errorMessage ?? "", /剧本已经用完/);
});

test("估算 token 用量", async () => {
	const faux = createFauxModel([{ text: "x".repeat(40) }]);
	const message = await stream(faux.model, { messages: [user("y".repeat(400))] }).result();
	assert.ok(message.usage.input >= 100);
	assert.equal(message.usage.output, 10);
});

test("取消：stopReason 是 aborted", async () => {
	const faux = createFauxModel([{ text: "一段很长的回复".repeat(20), delayMs: 5 }]);
	const controller = new AbortController();
	const response = stream(faux.model, { messages: [user("a")] }, { signal: controller.signal });
	for await (const event of response) {
		if (event.type === "text_delta") controller.abort();
	}
	const message = await response.result();
	assert.equal(message.stopReason, "aborted");
});

test("工具调用：产生 toolcall 事件，stopReason 是 toolUse，并记录收到的工具", async () => {
	const faux = createFauxModel([{ text: "我来读取。", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] }]);
	const tool = { name: "read", description: "读文件", parameters: { type: "object" as const } };
	const response = stream(faux.model, { messages: [user("读 a.txt")], tools: [tool] });
	const events = await collect(response);
	assert.ok(events.some((e) => e.type === "toolcall_start"));
	assert.ok(events.some((e) => e.type === "toolcall_end"));
	const message = await response.result();
	assert.equal(message.stopReason, "toolUse");
	const call = message.content.find((block) => block.type === "toolCall");
	assert.deepEqual(call?.type === "toolCall" ? call.arguments : undefined, { path: "a.txt" });
	assert.deepEqual(
		faux.requests[0].tools?.map((t) => t.name),
		["read"],
	);
});
