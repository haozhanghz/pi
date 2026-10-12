// OpenAI Chat Completions 协议的适配器（DeepSeek、通义千问、Kimi、智谱、Ollama 等都兼容这个协议）。
// 它做两件翻译：
//   1. 把我们统一的 Context 翻译成 OpenAI 的请求格式；
//   2. 把 OpenAI 的流式响应翻译成统一的 AssistantMessageEvent。
// 对应 pi 的 packages/ai/src/api/openai-completions.ts。
import { AssistantMessageEventStream } from "../event-stream.ts";
import { describeHttpError } from "../http.ts";
import { parseSSE } from "../sse.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Usage,
} from "../types.ts";
import { calculateCost, createEmptyUsage } from "../usage.ts";

// ---------------------------------------------------------------------------
// OpenAI 的数据格式（只列出我们用到的字段）
// ---------------------------------------------------------------------------

interface OpenAIMessage {
	role: "system" | "user" | "assistant";
	content: string | null;
}

interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	/** OpenAI 报告缓存命中的方式 */
	prompt_tokens_details?: { cached_tokens?: number };
	/** DeepSeek 报告缓存命中的方式 */
	prompt_cache_hit_tokens?: number;
}

interface OpenAIChunk {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
		};
		finish_reason?: string | null;
	}[];
	usage?: OpenAIUsage | null;
}

// ---------------------------------------------------------------------------
// 请求：Context → OpenAI 格式
// ---------------------------------------------------------------------------

/** 把我们的消息翻译成 OpenAI 的消息 */
export function convertMessages(context: Context): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	if (context.systemPrompt) {
		result.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages) {
		switch (message.role) {
			case "user":
				result.push({ role: "user", content: message.content });
				break;
			case "assistant": {
				// 只发送文字。之前几轮的思考内容不需要发回去（DeepSeek 等服务商的文档也是这么要求的）。
				// 里程碑 08 的工具循环里，"当前这一轮"的思考内容需要发回，到时候再处理。
				const text = message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
				// 没有文字的助手消息（比如刚开始就被取消了）不发送：很多服务商会拒绝空消息
				if (text.length === 0) break;
				result.push({ role: "assistant", content: text });
				break;
			}
		}
	}
	return result;
}

function buildRequestBody(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(context),
		stream: true,
		stream_options: { include_usage: true },
	};
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
function mapStopReason(reason: string | undefined): { stopReason: "stop" | "length" | "error"; errorMessage?: string } {
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
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

	// 用一个立即执行的 async 函数在后台工作，函数本身立刻返回 stream
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

			// 当前正在接收的内容块。同一时刻只有一个块是"打开"的。
			let current: TextContent | ThinkingContent | undefined;
			let finishReason: string | undefined;

			/** 结束当前的块：发出 text_end 或 thinking_end */
			const endCurrent = () => {
				if (!current) return;
				const contentIndex = output.content.length - 1;
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
						contentIndex: output.content.length - 1,
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
						contentIndex: output.content.length - 1,
						delta: delta.content,
						partial: output,
					});
				}

				if (choice.finish_reason) finishReason = choice.finish_reason;
			}
			endCurrent();

			if (options.signal?.aborted) throw new Error("请求被取消");
			const { stopReason, errorMessage } = mapStopReason(finishReason);
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
