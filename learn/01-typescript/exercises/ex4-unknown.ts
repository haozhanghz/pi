// 练习 4：处理"来路不明"的数据
// 网络上收到的数据、JSON.parse 的结果，类型都应该当成 unknown：你必须先检查，才能使用。
// 完成下面三个函数，然后运行：node exercises/ex4-unknown.ts
import assert from "node:assert/strict";

/**
 * 从一个大模型 API 的回复里取出文字。回复的格式应该是：
 *   { "choices": [ { "message": { "content": "..." } } ] }
 * 如果格式不对，抛出 Error("响应格式不对")。
 */
function extractContent(body: unknown): string {
	// 提示：一层一层检查。typeof x === "object" && x !== null，"key" in x，Array.isArray(x)
	throw new Error("TODO：请实现 extractContent");
}

/**
 * 把模型给出的"工具参数"（一个 JSON 字符串）解析成对象。
 * 解析失败、或者解析出来不是一个普通对象（比如是数组、数字、null），都返回 {}。
 */
function parseArguments(json: string): Record<string, unknown> {
	// 提示：JSON.parse 遇到不合法的 JSON 会抛出异常，用 try/catch 接住
	throw new Error("TODO：请实现 parseArguments");
}

/** 类型守卫：判断一个值是不是 { name: string; arguments: string } */
function isToolCall(value: unknown): value is { name: string; arguments: string } {
	throw new Error("TODO：请实现 isToolCall");
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
