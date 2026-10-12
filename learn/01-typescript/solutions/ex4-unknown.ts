// 练习 4：处理"来路不明"的数据（参考答案）
import assert from "node:assert/strict";

/**
 * 从一个大模型 API 的回复里取出文字。回复的格式应该是：
 *   { "choices": [ { "message": { "content": "..." } } ] }
 * 如果格式不对，抛出 Error("响应格式不对")。
 */
function extractContent(body: unknown): string {
	if (typeof body !== "object" || body === null) throw new Error("响应格式不对");
	if (!("choices" in body) || !Array.isArray(body.choices) || body.choices.length === 0) {
		throw new Error("响应格式不对");
	}
	const choice: unknown = body.choices[0];
	if (typeof choice !== "object" || choice === null || !("message" in choice)) throw new Error("响应格式不对");
	const message: unknown = choice.message;
	if (typeof message !== "object" || message === null || !("content" in message)) throw new Error("响应格式不对");
	if (typeof message.content !== "string") throw new Error("响应格式不对");
	return message.content;
}

/**
 * 把模型给出的"工具参数"（一个 JSON 字符串）解析成对象。
 * 解析失败、或者解析出来不是一个普通对象（比如是数组、数字、null），都返回 {}。
 */
function parseArguments(json: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(json);
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/** 类型守卫：判断一个值是不是 { name: string; arguments: string } */
function isToolCall(value: unknown): value is { name: string; arguments: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"arguments" in value &&
		typeof value.arguments === "string"
	);
}

// ----- 检查（不要修改下面的代码） -----
assert.equal(extractContent({ choices: [{ message: { content: "你好" } }] }), "你好");
assert.throws(() => extractContent(null), /响应格式不对/);
assert.throws(() => extractContent({ choices: [] }), /响应格式不对/);
assert.throws(() => extractContent({ choices: [{ message: { content: 42 } }] }), /响应格式不对/);
assert.throws(() => extractContent("hello"), /响应格式不对/);
assert.deepEqual(parseArguments('{"path":"a.txt"}'), { path: "a.txt" });
assert.deepEqual(parseArguments('{"path":'), {});
assert.deepEqual(parseArguments("[1,2,3]"), {});
assert.deepEqual(parseArguments("null"), {});
assert.equal(isToolCall({ name: "read", arguments: "{}" }), true);
assert.equal(isToolCall({ name: "read" }), false);
assert.equal(isToolCall({ name: 1, arguments: "{}" }), false);
assert.equal(isToolCall(undefined), false);
console.log("练习 4 全部通过！");
