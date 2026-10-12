// Agent Loop：整门课最核心的代码。
// 思路只有一句话：调用模型 → 如果它要求调用工具，就执行工具、把结果加入对话、再调用模型 → 直到它不再调用工具。
// 对应 pi 的 packages/agent/src/agent-loop.ts。
import { type AssistantMessage, type Message, stream, type ToolCall, type ToolResultMessage } from "../ai/index.ts";
import type { AgentContext, AgentEventSink, AgentLoopConfig, AgentTool, AgentToolResult } from "./types.ts";
import { validateToolArguments } from "./validate.ts";

/**
 * 运行一次 agent。
 *
 * @param prompts 这次新加入的消息（通常是一条用户消息）
 * @param context 之前的对话、系统提示词、可用的工具。context.messages 不会被修改
 * @param config 用哪个模型等配置
 * @param emit 接收事件（界面用它实时显示进度）
 * @param signal 用来中途取消
 * @returns 这次运行新产生的所有消息（包括 prompts），调用者把它们追加到自己的历史里
 */
export async function runAgentLoop(
	prompts: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<Message[]> {
	const messages: Message[] = [...context.messages]; // 工作副本
	const newMessages: Message[] = [];
	const append = (message: Message) => {
		messages.push(message);
		newMessages.push(message);
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		append(prompt);
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	while (true) {
		// ① 调用模型（流式），得到一条完整的回复
		const assistant = await streamAssistantResponse(messages, context, config, emit, signal);
		append(assistant);

		// ② 出错或被取消：这一轮结束，整个运行也结束
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			await emit({ type: "turn_end", message: assistant, toolResults: [] });
			break;
		}

		// ③ 执行模型要求调用的工具，每个调用都要产生一个结果
		const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
		const toolResults: ToolResultMessage[] = [];
		for (const call of toolCalls) {
			const result = await executeToolCall(call, assistant, context.tools, emit, signal);
			append(result);
			toolResults.push(result);
		}
		await emit({ type: "turn_end", message: assistant, toolResults });

		// ④ 没有工具调用：模型已经给出了最终回答
		if (toolCalls.length === 0) break;
		// ⑤ 工具执行期间被取消了：不再调用模型
		if (signal?.aborted) break;
		// ⑥ 带着工具结果，开始新的一轮
		await emit({ type: "turn_start" });
	}

	await emit({ type: "agent_end", messages: newMessages });
	return newMessages;
}

/** 调用一次模型，把流式事件转发出去，返回完整的回复 */
async function streamAssistantResponse(
	messages: Message[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	const streamFn = config.streamFn ?? stream;
	const response = streamFn(
		config.model,
		{ systemPrompt: context.systemPrompt, messages, tools: context.tools },
		{ apiKey: config.apiKey, signal, maxTokens: config.maxTokens, temperature: config.temperature },
	);

	let started = false;
	for await (const event of response) {
		if (event.type === "start") {
			started = true;
			await emit({ type: "message_start", message: event.partial });
		} else if (event.type !== "done" && event.type !== "error") {
			await emit({ type: "message_update", message: event.partial, event });
		}
	}
	const message = await response.result();
	// 请求在开始之前就失败了（比如 key 错误）：没有收到 start，这里补一个
	if (!started) await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

/** 执行一个工具调用：发出事件，返回工具结果消息。这个函数从不抛出异常 */
async function executeToolCall(
	call: ToolCall,
	assistant: AssistantMessage,
	tools: AgentTool[],
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolResultMessage> {
	await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });

	let result: AgentToolResult;
	let isError: boolean;
	if (assistant.stopReason === "length") {
		// 回复被截断了：工具参数可能不完整（parsePartialJson 会"尽力"解析出一个看似合法的半成品），执行它很危险
		result = textResult(
			`工具 ${call.name} 没有执行：回复达到了输出长度上限，参数可能不完整。请用完整的参数重新调用。`,
		);
		isError = true;
	} else if (signal?.aborted) {
		result = textResult("操作被取消，这个工具没有执行。");
		isError = true;
	} else {
		const tool = tools.find((candidate) => candidate.name === call.name);
		if (!tool) {
			const available = tools.map((candidate) => candidate.name).join("、") || "（没有）";
			result = textResult(`没有名为 ${call.name} 的工具。可用的工具有：${available}`);
			isError = true;
		} else {
			// 工具执行过程中报告的进度：先收集起来，工具结束后等它们都处理完，保证事件的顺序
			const updates: Promise<void>[] = [];
			let acceptingUpdates = true;
			try {
				const args = validateToolArguments(tool, call.arguments);
				result = await tool.execute(call.id, args, signal, (partialResult) => {
					if (!acceptingUpdates) return; // 工具已经结束了，晚到的进度报告忽略掉
					updates.push(
						Promise.resolve(
							emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, partialResult }),
						),
					);
				});
				isError = result.isError === true;
			} catch (error) {
				// 工具抛出异常（或者参数校验失败）：把错误信息作为结果发回给模型，让它想办法
				result = textResult(error instanceof Error ? error.message : String(error));
				isError = true;
			}
			acceptingUpdates = false;
			await Promise.all(updates);
		}
	}

	await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });

	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}
