// agent 层的类型。对应 pi 的 packages/agent/src/types.ts。
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	StreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../ai/index.ts";

/** 工具执行的结果 */
export interface AgentToolResult {
	/** 发给模型看的内容 */
	content: TextContent[];
	/** 给界面用的额外信息，不发给模型 */
	details?: unknown;
	/** 不抛异常也能报告失败：设为 true 时，模型会把 content 当作错误信息 */
	isError?: boolean;
}

/** 工具执行过程中报告进度（比如命令的输出一行行出现） */
export type AgentToolUpdate = (partial: AgentToolResult) => void;

/**
 * 一个可以被 agent 执行的工具：在 Tool（给模型看的定义）的基础上，加上真正执行它的函数。
 * 执行失败时直接抛出异常即可，agent 会把错误信息作为工具结果发回给模型。
 */
export interface AgentTool<TArgs = Record<string, unknown>> extends Tool {
	/** 给人看的名字（界面上显示） */
	label?: string;
	execute(toolCallId: string, args: TArgs, signal?: AbortSignal, onUpdate?: AgentToolUpdate): Promise<AgentToolResult>;
}

/** agent 运行时需要的上下文 */
export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools: AgentTool[];
}

/** 调用模型的函数，和 ai 层的 stream 一样。可以换成别的实现（比如加上自动重试） */
export type StreamFunction = (model: Model, context: Context, options?: StreamOptions) => AssistantMessageEventStream;

/** agent loop 的配置 */
export interface AgentLoopConfig {
	model: Model;
	apiKey?: string;
	maxTokens?: number;
	temperature?: number;
	/** 默认是 ai 层的 stream */
	streamFn?: StreamFunction;
}

/**
 * agent 运行时发出的事件，界面靠它们实时显示进度。
 *
 * 一次运行（prompt）的事件顺序：
 *   agent_start
 *   turn_start
 *     message_start/end（用户消息）
 *     message_start → message_update… → message_end（模型回复）
 *     tool_execution_start → tool_execution_update… → tool_execution_end（每个工具调用）
 *     message_start/end（工具结果消息）
 *   turn_end
 *   turn_start …（模型调用了工具，就再来一轮）
 *   agent_end
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage; event: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };

/** 接收事件的函数。可以是 async 的：agent 会等它处理完再继续 */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
