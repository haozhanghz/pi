// 练习 2：数组和对象（参考答案）
import assert from "node:assert/strict";

interface SimpleMessage {
	role: "system" | "user" | "assistant";
	text: string;
}

/** 找到最后一条指定角色的消息，没有就返回 undefined */
function lastMessageOf(messages: SimpleMessage[], role: SimpleMessage["role"]): SimpleMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === role) return messages[i];
	}
	return undefined;
}

/** 所有消息文字的总字符数 */
function totalChars(messages: SimpleMessage[]): number {
	let total = 0;
	for (const message of messages) total += message.text.length;
	return total;
}

/** 生成对话记录：每条一行，格式 "用户：xxx" / "助手：xxx" / "系统：xxx" */
function toTranscript(messages: SimpleMessage[]): string {
	const names = { system: "系统", user: "用户", assistant: "助手" };
	return messages.map((m) => `${names[m.role]}：${m.text}`).join("\n");
}

/** 返回一个去掉了某种角色的新数组，原数组不能被修改 */
function withoutRole(messages: SimpleMessage[], role: SimpleMessage["role"]): SimpleMessage[] {
	return messages.filter((m) => m.role !== role);
}

/** 返回一条新消息：内容是原消息加上后缀，原消息不能被修改 */
function appendText(message: SimpleMessage, suffix: string): SimpleMessage {
	return { ...message, text: message.text + suffix };
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
