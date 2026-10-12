import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createEmptyUsage, type Message, transformMessages } from "../src/ai/index.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): Message {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "m",
		usage: createEmptyUsage(),
		stopReason,
		timestamp: 0,
	};
}

const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const result = (id: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 0,
});

test("合法的历史原样保留", () => {
	const messages = [user("a"), assistant([call("1")]), result("1"), assistant([{ type: "text", text: "完成" }], "stop")];
	assert.deepEqual(transformMessages(messages), messages);
});

test("出错和被取消的助手消息不发送", () => {
	const messages = [
		user("a"),
		assistant([{ type: "text", text: "说到一半" }], "aborted"),
		user("b"),
		assistant([], "error"),
	];
	assert.deepEqual(
		transformMessages(messages).map((m) => m.role),
		["user", "user"],
	);
});

test("没有结果的工具调用会补上错误结果（在下一条用户消息之前）", () => {
	const messages = [user("a"), assistant([call("1"), call("2")]), result("1"), user("b")];
	const transformed = transformMessages(messages);
	assert.deepEqual(
		transformed.map((m) => (m.role === "toolResult" ? `toolResult:${m.toolCallId}:${m.isError}` : m.role)),
		["user", "assistant", "toolResult:1:false", "toolResult:2:true", "user"],
	);
});

test("结尾处没有结果的工具调用也会补上", () => {
	const transformed = transformMessages([user("a"), assistant([call("x")])]);
	const last = transformed.at(-1);
	assert.equal(last?.role, "toolResult");
	assert.equal(last?.role === "toolResult" ? last.isError : false, true);
});
