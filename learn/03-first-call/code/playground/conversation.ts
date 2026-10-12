// 综合项目：用类型描述一段对话，把它打印出来，做统计，再做一次 JSON 往返。
// 运行：node playground/conversation.ts

import type { AssistantMessage, Message, Role, TextContent } from "./messages.ts";
import { userMessage } from "./messages.ts";

// ---------- 一段"假装发生过"的对话 ----------
// 用户让助手看 package.json，助手调用 read 工具，拿到结果后回答。
const conversation: Message[] = [
	userMessage("帮我看看 package.json 里写了什么"),
	{
		role: "assistant",
		content: [
			{ type: "text", text: "好的，我来读取这个文件。" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "package.json" } },
		],
		timestamp: Date.now(),
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: '{ "name": "my-pi", "type": "module" }' }],
		isError: false,
		timestamp: Date.now(),
	},
	{
		role: "assistant",
		content: [{ type: "text", text: '这个项目叫 my-pi，并且使用了 ES Module（"type": "module"）。' }],
		timestamp: Date.now(),
	},
];

// ---------- 把一条消息格式化成一行或多行文字 ----------
function formatMessage(message: Message): string {
	switch (message.role) {
		case "user":
			// 在这里，TypeScript 知道 message 是 UserMessage
			return `[用户] ${message.content}`;
		case "assistant":
			// 在这里，TypeScript 知道 message 是 AssistantMessage
			return message.content
				.map((block) => {
					if (block.type === "text") return `[助手] ${block.text}`;
					return `[助手 → 工具] ${block.name}(${JSON.stringify(block.arguments)})`;
				})
				.join("\n");
		case "toolResult": {
			const text = message.content.map((block) => block.text).join("\n");
			const status = message.isError ? "（出错）" : "";
			return `[工具结果 ${message.toolName}${status}] ${text}`;
		}
		default: {
			// 穷尽检查：如果以后给 Message 加了新的 role 却忘了处理，这里会报类型错误
			const unreachable: never = message;
			throw new Error(`未知的消息：${JSON.stringify(unreachable)}`);
		}
	}
}

// ---------- 统计 ----------
function countByRole(messages: Message[]): Record<Role, number> {
	const counts: Record<Role, number> = { user: 0, assistant: 0, toolResult: 0 };
	for (const message of messages) {
		counts[message.role]++;
	}
	return counts;
}

function countToolCalls(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			count += message.content.filter((block) => block.type === "toolCall").length;
		}
	}
	return count;
}

/** 取出助手回复里的所有文字（类型守卫的例子：filter 之后 TypeScript 知道剩下的都是 TextContent） */
function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// ---------- 用一个类把对话和操作放在一起 ----------
class Conversation {
	private messages: Message[] = [];
	readonly title: string;

	constructor(title: string) {
		this.title = title;
	}

	add(message: Message): void {
		this.messages.push(message);
	}

	get length(): number {
		return this.messages.length;
	}

	/** 最后一条助手回复的文字，没有就返回 undefined */
	lastAssistantText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role === "assistant") return assistantText(message);
		}
		return undefined;
	}

	print(): void {
		console.log(`===== ${this.title} =====`);
		for (const message of this.messages) {
			console.log(formatMessage(message));
		}
	}
}

// ---------- 运行 ----------
const chat = new Conversation("一段关于 package.json 的对话");
for (const message of conversation) chat.add(message);
chat.print();

console.log("\n统计：", countByRole(conversation));
console.log("工具调用次数：", countToolCalls(conversation));
console.log("最后的回答：", chat.lastAssistantText());

// JSON 往返：把对话变成文字（可以保存到文件、发给服务器），再变回来
const json = JSON.stringify(conversation);
const restored = JSON.parse(json) as Message[];
console.log(`\nJSON 一共 ${json.length} 个字符，解析回来有 ${restored.length} 条消息`);
console.log("第一条消息：", formatMessage(restored[0]));
