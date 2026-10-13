import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createFauxModel, type Message, type ToolCall } from "../src/ai/index.ts";
import {
	collectFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	effectiveSettings,
	estimateContextTokens,
	estimateTextTokens,
	estimateTokens,
	findCutPoint,
	formatFileLists,
	generateSummary,
	serializeConversation,
	shouldCompact,
} from "../src/core/compaction.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });
function assistant(text: string, totalTokens = 0, toolCalls: ToolCall[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...toolCalls],
		api: "faux",
		provider: "faux",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
		timestamp: 0,
	};
}
const toolResult = (text: string): Message => ({
	role: "toolResult",
	toolCallId: "c",
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: "c", name, arguments: args });

test("估算 token：英文和代码 4 个字符一个，汉字一个字一个", () => {
	assert.equal(estimateTokens(user("12345678")), 2);
	assert.equal(estimateTokens(user("123456789")), 3, "向上取整");
	assert.equal(estimateTokens(toolResult("x".repeat(400))), 100);
	assert.equal(estimateTextTokens("你好，世界"), 5, "四个汉字，加上一个中文逗号（逗号不是汉字，按普通字符算，向上取整是 1）");
	assert.equal(estimateTextTokens("读取 package.json"), 2 + Math.ceil(13 / 4));
});

test("估算上下文：用最后一条回复报告的用量，加上之后的消息的估算", () => {
	const messages = [user("hi"), assistant("hello", 1000), toolResult("x".repeat(400))];
	assert.equal(estimateContextTokens(messages), 1000 + 100);
	assert.equal(estimateContextTokens([user("x".repeat(40))]), 10, "没有用量数据时全部估算");
});

test("什么时候压缩：上下文超过 窗口 - 预留", () => {
	const settings = DEFAULT_COMPACTION_SETTINGS;
	assert.equal(shouldCompact(100_000, 128_000, settings), false);
	assert.equal(shouldCompact(112_000, 128_000, settings), true);
	assert.equal(shouldCompact(112_000, 128_000, { ...settings, enabled: false }), false);
});

test("窗口很小的模型：预留和保留的 token 都不超过窗口的四分之一", () => {
	const small = effectiveSettings(DEFAULT_COMPACTION_SETTINGS, 8000);
	assert.equal(small.reserveTokens, 2000);
	assert.equal(small.keepRecentTokens, 2000);
	assert.deepEqual(effectiveSettings(DEFAULT_COMPACTION_SETTINGS, 200_000), DEFAULT_COMPACTION_SETTINGS);
});

test("切分点：从最新的往前累加到 keepRecentTokens，在用户或助手消息处切开", () => {
	const messages = [
		user("x".repeat(400)), // 100
		assistant("x".repeat(400)), // 100
		user("x".repeat(400)), // 100   ← 从这里开始保留
		assistant("x".repeat(400)), // 100
	];
	assert.equal(findCutPoint(messages, 200), 2);
	assert.equal(findCutPoint(messages, 10_000), 0, "全部加起来都不够：没有可以压缩的内容");
});

test("切分点：绝不在工具结果处切开", () => {
	const messages = [
		user("x".repeat(400)),
		assistant("调用工具", 0, [call("read", { path: "a" })]),
		toolResult("x".repeat(400)), // 累加到这里就够了，但不能从工具结果开始
		assistant("x".repeat(40)),
	];
	assert.equal(findCutPoint(messages, 100), 3, "往后找到下一条助手消息");
	assert.equal(findCutPoint(messages.slice(0, 3), 100), 1, "后面全是工具结果：在它前面的工具调用处切开");
});

test("把对话转成文字：标签、工具调用、工具结果截断", () => {
	const text = serializeConversation([
		user("读一下 a.ts"),
		assistant("好的", 0, [call("read", { path: "a.ts" })]),
		toolResult("y".repeat(2500)),
	]);
	assert.match(text, /^\[用户\]：读一下 a\.ts/);
	assert.match(text, /\[助手\]：好的/);
	assert.match(text, /\[助手调用工具\]：read\(path="a\.ts"\)/);
	assert.match(text, /\[工具结果\]：y{2000}\n\n\[……还有 500 个字符被省略\]/);
});

test("记录读过、改过的文件：改过的不再算在读过里；接着之前的记录", () => {
	const files = collectFileLists(
		[
			assistant("", 0, [call("read", { path: "a.ts" }), call("read", { path: "b.ts" }), call("edit", { path: "b.ts" })]),
			assistant("", 0, [call("write", { path: "c.ts" }), call("bash", { command: "ls" })]),
		],
		{ readFiles: ["old.ts"], modifiedFiles: [] },
	);
	assert.deepEqual(files, { readFiles: ["a.ts", "old.ts"], modifiedFiles: ["b.ts", "c.ts"] });
	assert.equal(formatFileLists(files), "\n\n<read-files>\na.ts\nold.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\n</modified-files>");
});

test("生成总结：请求里有对话和格式要求；再次压缩时带上之前的总结", async () => {
	const faux = createFauxModel([{ text: "## 目标\n- 重构" }, { text: "## 目标\n- 重构（更新）" }]);
	const first = await generateSummary([user("帮我重构")], faux.model);
	assert.equal(first.text, "## 目标\n- 重构");
	const request = faux.requests[0];
	assert.match(request.systemPrompt ?? "", /上下文总结助手/);
	const prompt = request.messages[0].role === "user" ? request.messages[0].content : "";
	assert.match(prompt, /<conversation>\n\[用户\]：帮我重构\n<\/conversation>/);
	assert.match(prompt, /## 关键上下文/);

	await generateSummary([user("继续")], faux.model, { previousSummary: "旧的总结", customInstructions: "记住数据库设计" });
	const second = faux.requests[1].messages[0];
	assert.ok(second.role === "user" && second.content.includes("<previous-summary>\n旧的总结\n</previous-summary>"));
	assert.ok(second.role === "user" && second.content.includes("额外的要求：记住数据库设计"));
});

test("生成总结失败：出错、被截断都抛出异常", async () => {
	const faux = createFauxModel([{ error: "服务器错误" }, { text: "半截", stopReason: "length" }]);
	await assert.rejects(generateSummary([user("x")], faux.model), /生成总结失败：服务器错误/);
	await assert.rejects(generateSummary([user("x")], faux.model), /被截断/);
});
