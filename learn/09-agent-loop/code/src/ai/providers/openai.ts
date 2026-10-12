// OpenAI Chat Completions 协议的适配器（DeepSeek、通义千问、Kimi、智谱、Ollama 等都兼容这个协议）。
// 它做两件翻译：
//   1. 把我们统一的 Context 翻译成 OpenAI 的请求格式；
//   2. 把 OpenAI 的流式响应翻译成统一的 AssistantMessageEvent。
// 对应 pi 的 packages/ai/src/api/openai-completions.ts。
import { AssistantMessageEventStream } from "../event-stream.ts";
import { describeHttpError } from "../http.ts";
import { parsePartialJson } from "../json.ts";
import { parseSSE } from "../sse.ts";
import { canReplayThinking, findLastUserIndex, transformMessages } from "../transform.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import { calculateCost, createEmptyUsage } from "../usage.ts";

// ---------------------------------------------------------------------------
// OpenAI 的数据格式（只列出我们用到的字段）
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type OpenAIMessage =
	| { role: "system" | "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: OpenAIToolCall[];
			/** 推理模型的思考内容。DeepSeek 等用 reasoning_content，也有服务商用 reasoning */
			reasoning_content?: string;
			reasoning?: string;
	  }
	| { role: "tool"; tool_call_id: string; content: string };

interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	/** OpenAI 报告缓存命中的方式 */
	prompt_tokens_details?: { cached_tokens?: number };
	/** DeepSeek 报告缓存命中的方式 */
	prompt_cache_hit_tokens?: number;
}

/** 流式工具调用的一个片段：第一个片段带 id 和函数名，后面的片段只带参数的一小段 */
interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: OpenAIToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
	usage?: OpenAIUsage | null;
}

// ---------------------------------------------------------------------------
// 请求：Context → OpenAI 格式
// ---------------------------------------------------------------------------

/** 把我们的消息翻译成 OpenAI 的消息 */
export function convertMessages(model: Model, context: Context): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	if (context.systemPrompt) {
		result.push({ role: "system", content: context.systemPrompt });
	}
	const messages = transformMessages(context.messages);
	const lastUser = findLastUserIndex(messages);

	messages.forEach((message, index) => {
		switch (message.role) {
			case "user":
				result.push({ role: "user", content: message.content });
				break;

			case "assistant": {
				const text = message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
				const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
				// 既没有文字也没有工具调用（比如刚开始就被取消了）：不发送，很多服务商会拒绝空消息
				if (text.length === 0 && toolCalls.length === 0) break;

				const converted: OpenAIMessage = { role: "assistant", content: text.length > 0 ? text : null };
				if (toolCalls.length > 0) {
					converted.tool_calls = toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.arguments) },
					}));
				}
				// 当前这一轮的思考内容，放回它原来所在的字段（工具循环里服务商需要它）
				if (canReplayThinking(message, index, lastUser, model)) {
					const thinking = message.content.filter((block): block is ThinkingContent => block.type === "thinking");
					const field = thinking[0]?.signature;
					if (field === "reasoning_content" || field === "reasoning") {
						converted[field] = thinking.map((block) => block.thinking).join("");
					}
				}
				result.push(converted);
				break;
			}

			case "toolResult": {
				const text = message.content.map((block) => block.text).join("\n");
				result.push({ role: "tool", tool_call_id: message.toolCallId, content: text || "(没有输出)" });
				break;
			}
		}
	});
	return result;
}

function convertTools(tools: Tool[]) {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

function buildRequestBody(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (context.tools && context.tools.length > 0) body.tools = convertTools(context.tools);
	if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	return body;
}

// ---------------------------------------------------------------------------
// 响应：OpenAI 格式 → 统一的事件
// ---------------------------------------------------------------------------

function parseUsage(raw: OpenAIUsage, model: Model): Usage {
	const usage = createEmptyUsage();
	const prompt = raw.prompt_tokens ?? 0;
	const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
	usage.input = Math.max(0, prompt - cached);
	usage.cacheRead = cached;
	usage.output = raw.completion_tokens ?? 0;
	usage.totalTokens = usage.input + usage.cacheRead + usage.output;
	calculateCost(model, usage);
	return usage;
}

/** 把 OpenAI 的 finish_reason 翻译成我们的 stopReason */
function mapStopReason(
	reason: string | undefined,
	hasToolCalls: boolean,
): { stopReason: "stop" | "length" | "toolUse" | "error"; errorMessage?: string } {
	switch (reason) {
		case "stop":
			// 有的服务商调用工具时也返回 stop，以实际内容为准
			return { stopReason: hasToolCalls ? "toolUse" : "stop" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		case "length":
			return { stopReason: "length" };
		case undefined:
			return { stopReason: "error", errorMessage: "响应在没有 finish_reason 的情况下结束了（连接可能中断了）" };
		default:
			return { stopReason: "error", errorMessage: `服务商返回了意外的停止原因：${reason}` };
	}
}

/**
 * 发起一次流式请求。
 * 约定：这个函数从不抛出异常。所有错误（网络、HTTP、取消）都会变成一个 error 事件，
 * 最终结果是一个 stopReason 为 "error" 或 "aborted" 的 AssistantMessage。
 */
export function streamOpenAI(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	// 这就是不断被填充的 partial
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
			const response = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
					...model.headers,
				},
				body: JSON.stringify(buildRequestBody(model, context, options)),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(await describeHttpError(response));
			if (!response.body) throw new Error("响应没有内容");

			stream.push({ type: "start", partial: output });

			// 当前正在接收的文字或思考块。同一时刻只有一个是"打开"的。
			let current: TextContent | ThinkingContent | undefined;
			// 工具调用按 OpenAI 给的 index 区分，参数是一段段拼起来的 JSON 文字
			const toolCalls = new Map<number, { block: ToolCall; json: string }>();
			let finishReason: string | undefined;

			/** 结束当前的文字或思考块：发出 text_end 或 thinking_end */
			const endCurrent = () => {
				if (!current) return;
				const contentIndex = output.content.indexOf(current);
				if (current.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: current.text, partial: output });
				} else {
					stream.push({ type: "thinking_end", contentIndex, content: current.thinking, partial: output });
				}
				current = undefined;
			};

			for await (const event of parseSSE(response.body)) {
				if (event.data === "[DONE]") break;
				const chunk = JSON.parse(event.data) as OpenAIChunk;
				if (chunk.usage) output.usage = parseUsage(chunk.usage, model);

				const choice = chunk.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta ?? {};

				// 思考内容：不同服务商用的字段名不同，记下字段名，回放时原样放回
				const reasoningField = delta.reasoning_content ? "reasoning_content" : delta.reasoning ? "reasoning" : undefined;
				if (reasoningField) {
					const piece = delta[reasoningField] ?? "";
					if (current?.type !== "thinking") {
						endCurrent();
						current = { type: "thinking", thinking: "", signature: reasoningField };
						output.content.push(current);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					}
					current.thinking += piece;
					stream.push({
						type: "thinking_delta",
						contentIndex: output.content.indexOf(current),
						delta: piece,
						partial: output,
					});
				}

				// 正文
				if (delta.content) {
					if (current?.type !== "text") {
						endCurrent();
						current = { type: "text", text: "" };
						output.content.push(current);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					}
					current.text += delta.content;
					stream.push({
						type: "text_delta",
						contentIndex: output.content.indexOf(current),
						delta: delta.content,
						partial: output,
					});
				}

				// 工具调用
				for (const callDelta of delta.tool_calls ?? []) {
					endCurrent();
					const index = callDelta.index ?? 0;
					let entry = toolCalls.get(index);
					if (!entry) {
						entry = {
							block: { type: "toolCall", id: callDelta.id ?? `call_${index}`, name: "", arguments: {} },
							json: "",
						};
						toolCalls.set(index, entry);
						output.content.push(entry.block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
					if (callDelta.id) entry.block.id = callDelta.id;
					// 函数名通常在第一个片段里一次性给出；有的服务商每个片段都重复一遍，所以只设置一次
					if (callDelta.function?.name && !entry.block.name) entry.block.name = callDelta.function.name;
					const piece = callDelta.function?.arguments ?? "";
					if (piece) {
						entry.json += piece;
						// 参数还没写完，尽力解析出半成品，界面可以提前显示
						entry.block.arguments = parsePartialJson(entry.json);
						stream.push({
							type: "toolcall_delta",
							contentIndex: output.content.indexOf(entry.block),
							delta: piece,
							partial: output,
						});
					}
				}

				if (choice.finish_reason) finishReason = choice.finish_reason;
			}
			endCurrent();
			// 流结束时，所有工具调用的参数都已完整
			for (const { block, json } of toolCalls.values()) {
				block.arguments = parsePartialJson(json);
				stream.push({ type: "toolcall_end", contentIndex: output.content.indexOf(block), toolCall: block, partial: output });
			}

			if (options.signal?.aborted) throw new Error("请求被取消");
			const { stopReason, errorMessage } = mapStopReason(finishReason, toolCalls.size > 0);
			if (stopReason === "error") throw new Error(errorMessage);
			output.stopReason = stopReason;
			stream.push({ type: "done", reason: stopReason, message: output });
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
