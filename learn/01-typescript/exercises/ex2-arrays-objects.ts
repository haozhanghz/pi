// 练习 2：数组和对象
// 完成下面五个函数，然后运行：node exercises/ex2-arrays-objects.ts
// 注意："原数组/原消息不能被修改"——要返回新的数组或对象。
import assert from "node:assert/strict";

interface SimpleMessage {
	role: "system" | "user" | "assistant";
	text: string;
}

/** 找到最后一条指定角色的消息，没有就返回 undefined */
function lastMessageOf(messages: SimpleMessage[], role: SimpleMessage["role"]): SimpleMessage | undefined {
	// 提示：从后往前循环 for (let i = messages.length - 1; i >= 0; i--)
	throw new Error("TODO：请实现 lastMessageOf");
}

/** 所有消息文字的总字符数 */
function totalChars(messages: SimpleMessage[]): number {
	throw new Error("TODO：请实现 totalChars");
}

/** 生成对话记录：每条一行，格式 "用户：xxx" / "助手：xxx" / "系统：xxx" */
function toTranscript(messages: SimpleMessage[]): string {
	// 提示：先用 map 把每条消息变成一行文字，再用 join("\n") 连起来
	throw new Error("TODO：请实现 toTranscript");
}

/** 返回一个去掉了某种角色的新数组，原数组不能被修改 */
function withoutRole(messages: SimpleMessage[], role: SimpleMessage["role"]): SimpleMessage[] {
	throw new Error("TODO：请实现 withoutRole");
}

/** 返回一条新消息：内容是原消息加上后缀，原消息不能被修改 */
function appendText(message: SimpleMessage, suffix: string): SimpleMessage {
	// 提示：展开运算符 { ...message, text: ... }
	throw new Error("TODO：请实现 appendText");
}

// ----- 检查（不要修改下面的代码） -----
const messages: SimpleMessage[] = [
	{ role: "system", text: "你是助手" },
	{ role: "user", text: "你好" },
	{ role: "assistant", text: "你好！有什么可以帮你？" },
	{ role: "user", text: "讲个笑话" },
];
assert.deepEqual(lastMessageOf(messages, "user"), { role: "user", text: "讲个笑话" });
assert.equal(lastMessageOf([], "user"), undefined);
assert.equal(totalChars(messages), 4 + 2 + 11 + 4);
assert.equal(toTranscript(messages.slice(1, 3)), "用户：你好\n助手：你好！有什么可以帮你？");
const filtered = withoutRole(messages, "system");
assert.equal(filtered.length, 3);
assert.equal(messages.length, 4, "原数组不应该被修改");
const original = messages[1];
const longer = appendText(original, "呀");
assert.equal(longer.text, "你好呀");
assert.equal(original.text, "你好", "原消息不应该被修改");
console.log("练习 2 全部通过！");
