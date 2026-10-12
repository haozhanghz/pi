// Anthropic Messages 协议的适配器。
// 和 openai.ts 做同样的两件翻译，只是 Anthropic 的格式完全不同：
//   - 系统提示词是请求体里单独的 system 字段，不是一条消息；
//   - max_tokens 是必填的；
//   - 工具调用是助手消息里的 tool_use 块，工具结果是用户消息里的 tool_result 块；
//   - 流式响应用 event: 字段区分事件类型，每个内容块都有明确的开始和结束。
// 对应 pi 的 packages/ai/src/api/anthropic-messages.ts。
import { AssistantMessageEventStream } from "../event-stream.ts";
import { describeHttpError } from "../http.ts";
import { parsePartialJson } from "../json.ts";
import { parseSSE } from "../sse.ts";
import { canReplayThinking, findLastUserIndex, transformMessages } from "../transform.ts";
import type { AssistantMessage, Context, Model, StreamOptions, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { calculateCost, createEmptyUsage } from "../usage.ts";

// ---------------------------------------------------------------------------
// Anthropic 的数据格式（只列出我们用到的字段）
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** 流式响应里的事件（只列出我们处理的几种） */
type AnthropicStreamEvent =
	| { type: "message_start"; message: { usage?: AnthropicUsage } }
	| {
			type: "content_block_start";
			index: number;
			content_block: { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string };
	  }
	| {
			type: "content_block_delta";
			index: number;
			delta: { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
	  }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; delta: { stop_reason?: string | null }; usage?: AnthropicUsage }
	| { type: "message_stop" }
	| { type: "ping" }
	| { type: "error"; error: { type: string; message: string } };

// ---------------------------------------------------------------------------
// 请求：Context → Anthropic 格式
// ---------------------------------------------------------------------------

export function convertMessages(model: Model, context: Context): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];
	const messages = transformMessages(context.messages);
	const lastUser = findLastUserIndex(messages);

	messages.forEach((message, index) => {
		switch (message.role) {
			case "user":
				result.push({ role: "user", content: message.content });
				break;

			case "assistant": {
				const replayThinking = canReplayThinking(message, index, lastUser, model);
				const blocks: AnthropicContentBlock[] = [];
				for (const block of message.content) {
					if (block.type === "text" && block.text.length > 0) {
						blocks.push({ type: "text", text: block.text });
					} else if (block.type === "thinking" && replayThinking && block.signature) {
						// 当前这一轮、同一个模型的思考块：连同签名原样发回（工具循环里 Anthropic 要求这样做）
						blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
					} else if (block.type === "toolCall") {
						blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
					}
				}
				if (blocks.length === 0) break;
				result.push({ role: "assistant", content: blocks });
				break;
			}

			case "toolResult": {
				const block: AnthropicContentBlock = {
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: message.content.map((item) => item.text).join("\n") || "(没有输出)",
					is_error: message.isError,
				};
				// 一次回复里的多个工具调用，结果要放在同一条 user 消息里：
				// 如果上一条已经是装着工具结果的 user 消息，就追加进去
				const previous = result.at(-1);
				if (previous?.role === "user" && Array.isArray(previous.content)) {
					previous.content.push(block);
				} else {
					result.push({ role: "user", content: [block] });
				}
				break;
			}
		}
	});
	return result;
}

function buildRequestBody(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		// Anthropic 要求必须提供 max_tokens
		max_tokens: options.maxTokens ?? model.maxTokens,
		messages: convertMessages(model, context),
		stream: true,
	};
	if (context.systemPrompt) body.system = context.systemPrompt;
	if (context.tools && context.tools.length > 0) {
		body.tools = context.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}
	// 注意：新一代 Claude 模型不接受 temperature，传了会返回 400。只有明确设置时才发送。
	if (options.temperature !== undefined) body.temperature = options.temperature;
	return body;
}

// ---------------------------------------------------------------------------
// 响应：Anthropic 格式 → 统一的事件
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null | undefined): {
	stopReason: "stop" | "length" | "toolUse" | "error";
	errorMessage?: string;
} {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return { stopReason: "stop" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "max_tokens":
		case "model_context_window_exceeded":
			return { stopReason: "length" };
		case "refusal":
			return { stopReason: "error", errorMessage: "模型拒绝了这个请求（stop_reason: refusal）" };
		case undefined:
		case null:
			return { stopReason: "error", errorMessage: "响应在没有 stop_reason 的情况下结束了（连接可能中断了）" };
		default:
			return { stopReason: "error", errorMessage: `服务商返回了意外的停止原因：${reason}` };
	}
}

export function streamAnthropic(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			const response = await fetch(`${model.baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
					...model.headers,
				},
				body: JSON.stringify(buildRequestBody(model, context, options)),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(await describeHttpError(response));
			if (!response.body) throw new Error("响应没有内容");

			stream.push({ type: "start", partial: output });

			// Anthropic 用 index 标识内容块。我们记下"Anthropic 的 index → 我们的块"的对应关系，
			// 遇到不认识的块类型就跳过它。工具调用块还要攒着参数的 JSON 文字。
			const blocks = new Map<number, TextContent | ThinkingContent | ToolCall>();
			const toolJson = new Map<ToolCall, string>();
			let stopReason: string | null | undefined;

			/** Anthropic 的用量分两次报告：开始时报告输入，结束时报告输出 */
			const applyUsage = (raw: AnthropicUsage | undefined) => {
				if (!raw) return;
				if (raw.input_tokens !== undefined) output.usage.input = raw.input_tokens;
				if (raw.output_tokens !== undefined) output.usage.output = raw.output_tokens;
				if (raw.cache_read_input_tokens !== undefined) output.usage.cacheRead = raw.cache_read_input_tokens;
				if (raw.cache_creation_input_tokens !== undefined) output.usage.cacheWrite = raw.cache_creation_input_tokens;
				const usage = output.usage;
				usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				calculateCost(model, usage);
			};

			for await (const sse of parseSSE(response.body)) {
				const event = JSON.parse(sse.data) as AnthropicStreamEvent;
				switch (event.type) {
					case "message_start":
						applyUsage(event.message.usage);
						break;

					case "content_block_start": {
						const start = event.content_block;
						if (start.type === "text") {
							const block: TextContent = { type: "text", text: start.text ?? "" };
							output.content.push(block);
							blocks.set(event.index, block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						} else if (start.type === "thinking") {
							const block: ThinkingContent = { type: "thinking", thinking: start.thinking ?? "", signature: start.signature };
							output.content.push(block);
							blocks.set(event.index, block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (start.type === "tool_use") {
							const block: ToolCall = { type: "toolCall", id: start.id ?? "", name: start.name ?? "", arguments: {} };
							output.content.push(block);
							blocks.set(event.index, block);
							toolJson.set(block, "");
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
						break;
					}

					case "content_block_delta": {
						const block = blocks.get(event.index);
						if (!block) break; // 我们不处理的块类型
						const contentIndex = output.content.indexOf(block);
						const delta = event.delta;
						if (delta.type === "text_delta" && block.type === "text" && delta.text) {
							block.text += delta.text;
							stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
						} else if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking) {
							block.thinking += delta.thinking;
							stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
						} else if (delta.type === "signature_delta" && block.type === "thinking" && delta.signature) {
							// 签名在思考块结束前一次性发来，以后把思考内容发回去时要原样带上
							block.signature = (block.signature ?? "") + delta.signature;
						} else if (delta.type === "input_json_delta" && block.type === "toolCall" && delta.partial_json) {
							const json = (toolJson.get(block) ?? "") + delta.partial_json;
							toolJson.set(block, json);
							block.arguments = parsePartialJson(json);
							stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
						}
						break;
					}

					case "content_block_stop": {
						const block = blocks.get(event.index);
						if (!block) break;
						const contentIndex = output.content.indexOf(block);
						if (block.type === "text") {
							stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
						} else if (block.type === "thinking") {
							stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
						} else {
							block.arguments = parsePartialJson(toolJson.get(block) ?? "");
							stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
						}
						break;
					}

					case "message_delta":
						if (event.delta.stop_reason !== undefined) stopReason = event.delta.stop_reason;
						applyUsage(event.usage);
						break;

					case "error":
						// 流式响应中途出错（比如服务器过载），服务器会发来一个 error 事件
						throw new Error(`${event.error.type}：${event.error.message}`);

					// message_stop、ping 以及其他不认识的事件：忽略
				}
			}

			if (options.signal?.aborted) throw new Error("请求被取消");
			const mapped = mapStopReason(stopReason);
			if (mapped.stopReason === "error") throw new Error(mapped.errorMessage);
			output.stopReason = mapped.stopReason;
			stream.push({ type: "done", reason: mapped.stopReason, message: output });
			stream.end();
		} catch (error) {
			const reason = options.signal?.aborted ? "aborted" : "error";
			output.stopReason = reason;
			output.errorMessage = reason === "aborted" ? "请求被取消" : error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason, error: output });
			stream.end();
		}
	})();

	return stream;
}
