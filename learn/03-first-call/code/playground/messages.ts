// 用类型描述"一段对话"。这个文件只导出类型和一个小函数，被 conversation.ts 导入。
// 到了里程碑 06，你会写出几乎一样的 src/ai/types.ts。

/** 一段文字 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 模型请求调用一个工具 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** 用户说的话 */
export interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

/** 模型的回复：可以同时包含文字和工具调用 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ToolCall)[];
	timestamp: number;
}

/** 工具执行完的结果 */
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
	timestamp: number;
}

/** 联合类型：一条消息是这三种之一，用 role 字段区分 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 所有可能的 role，等于 "user" | "assistant" | "toolResult" */
export type Role = Message["role"];

/** 创建一条用户消息的小工具 */
export function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}
