// 假模型（faux）：在进程内按剧本生成回复，不发任何网络请求。专门用来写测试。
// 它也是一个"适配器"——只是背后不是真正的服务商，而是一份剧本。
// 对应 pi 的 packages/ai/src/providers/faux.ts。
import { AssistantMessageEventStream } from "../event-stream.ts";
import type { AssistantMessage, Context, Model, StreamOptions } from "../types.ts";
import { createEmptyUsage } from "../usage.ts";

/** 剧本里的一次回复 */
export interface FauxReply {
	text?: string;
	thinking?: string;
	/** 默认 "stop" */
	stopReason?: "stop" | "length";
	/** 设置后，这次回复以错误结束 */
	error?: string;
	/** 每个文字片段之间等待多少毫秒（测试"取消"时有用），默认 0 */
	delayMs?: number;
}

/** 剧本的一步：固定的回复，或者根据收到的上下文临时决定回复 */
export type FauxStep = FauxReply | ((context: Context) => FauxReply);

/** 假模型收到的一次请求（快照） */
export interface FauxRequest {
	systemPrompt?: string;
	messages: Context["messages"];
}

export interface FauxHandle {
	model: Model;
	/** 收到的所有请求，测试可以检查"发给模型的到底是什么" */
	requests: FauxRequest[];
	/** 追加剧本 */
	addReplies(...steps: FauxStep[]): void;
	/** 还剩几步没用 */
	readonly remaining: number;
}

interface FauxState {
	steps: FauxStep[];
	requests: FauxRequest[];
}

/** 每个假模型（按 id 区分）各自的剧本 */
const states = new Map<string, FauxState>();
let counter = 0;

/** 粗略估算 token 数：4 个字符算 1 个 token */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * 创建一个假模型。返回的 model 可以像真实模型一样传给 stream()。
 * 每次请求消耗剧本的一步；剧本用完时，请求以错误结束。
 */
export function createFauxModel(steps: FauxStep[] = [], options: { contextWindow?: number } = {}): FauxHandle {
	const id = `faux-${++counter}`;
	const state: FauxState = { steps: [...steps], requests: [] };
	states.set(id, state);
	const model: Model = {
		id,
		name: "Faux Model",
		api: "faux",
		provider: "faux",
		baseUrl: "",
		reasoning: false,
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return {
		model,
		requests: state.requests,
		addReplies: (...more) => {
			state.steps.push(...more);
		},
		get remaining() {
			return state.steps.length;
		},
	};
}

/** 把文字切成 3 个字符一段，模拟流式输出 */
function chunks(text: string): string[] {
	const chars = Array.from(text);
	const result: string[] = [];
	for (let i = 0; i < chars.length; i += 3) result.push(chars.slice(i, i + 3).join(""));
	return result;
}

/** 让出控制权：等事件循环转一圈（或者等待 ms 毫秒），模拟"数据陆续到达" */
function tick(ms: number): Promise<void> {
	return new Promise((resolve) => (ms > 0 ? setTimeout(resolve, ms) : setImmediate(resolve)));
}

export function streamFaux(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
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
			const state = states.get(model.id);
			if (!state) throw new Error(`没有找到假模型 ${model.id}，请用 createFauxModel() 创建`);
			// 记录请求的快照：复制一份消息数组，之后调用者修改数组也不影响记录
			state.requests.push({ systemPrompt: context.systemPrompt, messages: [...context.messages] });
			const step = state.steps.shift();
			if (!step) throw new Error("假模型的剧本已经用完了");
			const reply = typeof step === "function" ? step(context) : step;
			if (reply.error) throw new Error(reply.error);

			await tick(0);
			stream.push({ type: "start", partial: output });

			if (reply.thinking) {
				const block = { type: "thinking" as const, thinking: "" };
				output.content.push(block);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex, partial: output });
				for (const piece of chunks(reply.thinking)) {
					await tick(reply.delayMs ?? 0);
					if (options.signal?.aborted) throw new Error("请求被取消");
					block.thinking += piece;
					stream.push({ type: "thinking_delta", contentIndex, delta: piece, partial: output });
				}
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
			}

			if (reply.text) {
				const block = { type: "text" as const, text: "" };
				output.content.push(block);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: output });
				for (const piece of chunks(reply.text)) {
					await tick(reply.delayMs ?? 0);
					if (options.signal?.aborted) throw new Error("请求被取消");
					block.text += piece;
					stream.push({ type: "text_delta", contentIndex, delta: piece, partial: output });
				}
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
			}

			if (options.signal?.aborted) throw new Error("请求被取消");

			// 估算用量：输入是整个上下文，输出是这次回复
			const inputText =
				(context.systemPrompt ?? "") + context.messages.map((message) => JSON.stringify(message.content)).join("");
			output.usage.input = estimateTokens(inputText);
			output.usage.output = estimateTokens((reply.thinking ?? "") + (reply.text ?? ""));
			output.usage.totalTokens = output.usage.input + output.usage.output;

			const stopReason = reply.stopReason ?? "stop";
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
