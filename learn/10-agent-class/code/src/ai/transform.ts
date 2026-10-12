// 各个适配器在"翻译消息"之前共用的处理。
// 对应 pi 的 packages/ai/src/api/transform-messages.ts（pi 的规则更多）。
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "./types.ts";

/**
 * 发给模型之前，先把历史整理成"一定合法"的样子。两道保险：
 *
 * 1. 出错或被取消的助手消息不发送。它们是没完成的回复，里面可能有写了一半的工具调用，
 *    发给模型可能导致请求被拒绝。（它们仍然保存在历史里，界面可以显示，只是不发给模型。）
 * 2. 每个工具调用后面都必须有对应的工具结果。如果有调用没有结果（比如执行到一半程序崩溃了），
 *    就补上一个"没有结果"的错误结果。
 */
export function transformMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let pending: ToolCall[] = []; // 上一条助手消息里、还没有找到结果的工具调用
	let answered = new Set<string>();

	const closePending = () => {
		for (const call of pending) {
			if (answered.has(call.id)) continue;
			const synthetic: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "没有结果（这个工具调用没有被执行）" }],
				isError: true,
				timestamp: Date.now(),
			};
			result.push(synthetic);
		}
		pending = [];
		answered = new Set();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			closePending();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			pending = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			result.push(message);
		} else if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			result.push(message);
		} else {
			// 新的用户消息：上一轮没有结果的工具调用，在这之前补上
			closePending();
			result.push(message);
		}
	}
	closePending();
	return result;
}

/** 最后一条用户消息的位置；没有用户消息时返回 -1 */
export function findLastUserIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/**
 * 这条助手消息里的思考内容，能不能发回给 model？
 * 两个条件都要满足：
 *   1. 它属于"当前这一轮"：在最后一条用户消息之后。工具循环里，服务商要求把这一轮的思考原样发回；
 *      之前几轮的思考对模型没有用，也不应该发回（而且改动过的历史会让它们失效）。
 *   2. 它是同一个模型生成的：思考内容（尤其是 Anthropic 的签名）只对生成它的模型有效。
 */
export function canReplayThinking(message: AssistantMessage, index: number, lastUserIndex: number, model: Model): boolean {
	return (
		index > lastUserIndex && message.api === model.api && message.provider === model.provider && message.model === model.id
	);
}
