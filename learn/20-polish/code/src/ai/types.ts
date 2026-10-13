// mini-pi 的核心类型。ai 层、agent 层、界面都使用这些类型。
// 对应 pi 的 packages/ai/src/types.ts。

// ---------------------------------------------------------------------------
// 内容块：一条消息由若干个"块"组成
// ---------------------------------------------------------------------------

/** 一段文字 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 模型的思考过程（推理模型才有） */
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/**
	 * 把思考内容发回给服务商时需要的信息。对 OpenAI 兼容接口，我们在这里记下思考内容来自哪个字段
	 * （比如 "reasoning_content"）；对 Anthropic，这里是它返回的签名。
	 */
	signature?: string;
}

/** 模型请求调用一个工具 */
export interface ToolCall {
	type: "toolCall";
	/** 这次调用的唯一编号，工具结果用它指回这次调用 */
	id: string;
	/** 工具名 */
	name: string;
	/** 参数（模型生成的 JSON 解析后的对象） */
	arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/** 用户说的话 */
export interface UserMessage {
	role: "user";
	content: string;
	/** 创建时间（毫秒） */
	timestamp: number;
}

/** 模型为什么停止输出 */
export type StopReason =
	| "stop" // 正常说完
	| "length" // 达到输出长度上限，被截断
	| "toolUse" // 要调用工具，等待工具结果
	| "error" // 出错
	| "aborted"; // 被用户取消

/** token 用量和费用 */
export interface Usage {
	/** 输入 token（不含缓存命中的部分） */
	input: number;
	/** 输出 token */
	output: number;
	/** 命中缓存的输入 token（通常便宜很多） */
	cacheRead: number;
	/** 写入缓存的输入 token */
	cacheWrite: number;
	totalTokens: number;
	/** 费用（美元），按模型价格计算 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** 模型的回复 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** 用哪种接口协议生成的 */
	api: Api;
	/** 哪家服务商 */
	provider: string;
	/** 哪个模型 */
	model: string;
	usage: Usage;
	stopReason: StopReason;
	/** stopReason 为 error 或 aborted 时的说明 */
	errorMessage?: string;
	timestamp: number;
}

/** 工具执行完的结果，发回给模型 */
export interface ToolResultMessage {
	role: "toolResult";
	/** 对应哪一次工具调用（ToolCall.id） */
	toolCallId: string;
	toolName: string;
	/** 发给模型看的内容 */
	content: TextContent[];
	/** 工具执行是否失败。失败时 content 里是错误信息 */
	isError: boolean;
	/** 给界面用的额外信息（比如修改文件时的 diff），不会发给模型 */
	details?: unknown;
	timestamp: number;
}

/** 一段对话里的消息 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * JSON Schema 的一个子集：用来描述工具的参数长什么样。
 * 例如 { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
 */
export interface JsonSchema {
	type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: (string | number | boolean)[];
	additionalProperties?: boolean;
}

/** 告诉模型"你可以调用这个工具" */
export interface Tool {
	name: string;
	/** 工具是做什么的、什么时候该用它。模型完全靠这段文字决定要不要调用 */
	description: string;
	/** 参数的 JSON Schema，顶层必须是 type: "object" */
	parameters: JsonSchema;
}

// ---------------------------------------------------------------------------
// 模型与请求
// ---------------------------------------------------------------------------

/**
 * 接口协议。不同服务商可能使用同一种协议（比如 DeepSeek 和 Kimi 都用 openai-completions）。
 * faux 是进程内的假模型，专门用来写测试。
 */
export type Api = "openai-completions" | "anthropic-messages" | "faux";

/** 一个模型的描述 */
export interface Model {
	/** 发给服务商的模型名，例如 "deepseek-chat" */
	id: string;
	/** 给人看的名字 */
	name: string;
	api: Api;
	/** 服务商的名字，例如 "deepseek" */
	provider: string;
	/** 接口地址，例如 "https://api.deepseek.com" */
	baseUrl: string;
	/** 是否是推理模型 */
	reasoning: boolean;
	/** 上下文窗口（token） */
	contextWindow: number;
	/** 最多输出多少 token */
	maxTokens: number;
	/** 价格：每百万 token 多少美元 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** 额外的请求头 */
	headers?: Record<string, string>;
}

/** 一次请求的上下文：系统提示词 + 对话历史 + 可用的工具 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/** 一次请求的选项 */
export interface StreamOptions {
	apiKey?: string;
	/** 用于取消请求 */
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
}

// ---------------------------------------------------------------------------
// 流式事件：所有服务商的流式响应，都被翻译成这同一套事件
// ---------------------------------------------------------------------------

/**
 * partial 是"到目前为止的回复"。注意：它是同一个对象，会随着新事件不断被修改；
 * 如果你需要保存某一时刻的快照，请自己复制一份。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	/** delta 是参数 JSON 的一小段文字；partial 里对应的 ToolCall.arguments 是"尽力解析"出来的半成品 */
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };
