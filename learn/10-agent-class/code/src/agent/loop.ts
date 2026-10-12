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
	/** 加入一条从外面来的消息（提问、插话、排队的消息），并发出事件 */
	const appendWithEvents = async (message: Message) => {
		append(message);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) await appendWithEvents(prompt);

	// 用户可能在 agent 启动前就插话了
	let pending: Message[] = (await config.getSteeringMessages?.()) ?? [];
	let firstTurn = true;

	// 外层循环：agent 本来要停下时，看看有没有排队的消息（follow-up）
	outer: while (true) {
		let hasMoreToolCalls = true;

		// 内层循环：还有工具调用、或者有插话，就继续
		while (hasMoreToolCalls || pending.length > 0) {
			if (!firstTurn) await emit({ type: "turn_start" });
			firstTurn = false;

			// ① 把插话或排队的消息加入对话
			for (const message of pending) await appendWithEvents(message);
			pending = [];

			// ② 调用模型（流式），得到一条完整的回复
			const assistant = await streamAssistantResponse(messages, context, config, emit, signal);
			append(assistant);

			// ③ 出错或被取消：这一轮结束，整个运行也结束
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
				await emit({ type: "turn_end", message: assistant, toolResults: [] });
				break outer;
			}

			// ④ 执行模型要求调用的工具，每个调用都要产生一个结果
			const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
			const toolResults =
				config.toolExecution === "sequential"
					? await executeSequential(toolCalls, assistant, context.tools, emit, signal)
					: await executeParallel(toolCalls, assistant, context.tools, emit, signal);
			for (const result of toolResults) append(result);
			await emit({ type: "turn_end", message: assistant, toolResults });

			// ⑤ 工具执行期间被取消了：不再调用模型
			if (signal?.aborted) break outer;

			// ⑥ 没有工具调用时，模型已经给出了最终回答；但用户可能刚刚插了话
			hasMoreToolCalls = toolCalls.length > 0;
			pending = (await config.getSteeringMessages?.()) ?? [];
		}

		// ⑦ agent 本来要停下了。有排队的消息就继续，没有就真的结束
		pending = (await config.getFollowUpMessages?.()) ?? [];
		if (pending.length === 0) break;
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

// ---------- 执行工具 ----------

/** 一个工具调用的最终结果 */
interface ToolOutcome {
	result: AgentToolResult;
	isError: boolean;
}

/** 准备的结果：要么可以执行（ready），要么已经知道结果了（failed） */
type Preparation =
	| { kind: "ready"; call: ToolCall; tool: AgentTool; args: Record<string, unknown> }
	| { kind: "failed"; outcome: ToolOutcome };

/** 准备一个工具调用：检查能不能执行、找到工具、校验参数 */
function prepareToolCall(
	call: ToolCall,
	assistant: AssistantMessage,
	tools: AgentTool[],
	signal: AbortSignal | undefined,
): Preparation {
	if (assistant.stopReason === "length") {
		// 回复被截断了：工具参数可能不完整（parsePartialJson 会"尽力"解析出一个看似合法的半成品），执行它很危险
		return failed(`工具 ${call.name} 没有执行：回复达到了输出长度上限，参数可能不完整。请用完整的参数重新调用。`);
	}
	if (signal?.aborted) return failed("操作被取消，这个工具没有执行。");
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		const available = tools.map((candidate) => candidate.name).join("、") || "（没有）";
		return failed(`没有名为 ${call.name} 的工具。可用的工具有：${available}`);
	}
	try {
		return { kind: "ready", call, tool, args: validateToolArguments(tool, call.arguments) };
	} catch (error) {
		// 参数校验失败：把问题告诉模型，让它改正
		return failed(errorText(error));
	}
}

/** 执行一个准备好的工具调用。这个函数从不抛出异常 */
async function runPreparedCall(
	prepared: Extract<Preparation, { kind: "ready" }>,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
	const { call, tool, args } = prepared;
	// 并行执行时，可能在排队等待期间就被取消了
	if (signal?.aborted) return errorOutcome("操作被取消，这个工具没有执行。");

	// 工具执行过程中报告的进度：先收集起来，工具结束后等它们都处理完，保证事件的顺序
	const updates: Promise<void>[] = [];
	let acceptingUpdates = true;
	let outcome: ToolOutcome;
	try {
		const result = await tool.execute(call.id, args, signal, (partialResult) => {
			if (!acceptingUpdates) return; // 工具已经结束了，晚到的进度报告忽略掉
			updates.push(
				Promise.resolve(emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, partialResult })),
			);
		});
		outcome = { result, isError: result.isError === true };
	} catch (error) {
		// 工具抛出异常：把错误信息作为结果发回给模型，让它想办法
		outcome = errorOutcome(errorText(error));
	}
	acceptingUpdates = false;
	await Promise.all(updates);
	return outcome;
}

/** 一个接一个地执行 */
async function executeSequential(
	calls: ToolCall[],
	assistant: AssistantMessage,
	tools: AgentTool[],
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const call of calls) {
		await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
		const preparation = prepareToolCall(call, assistant, tools, signal);
		const outcome = preparation.kind === "ready" ? await runPreparedCall(preparation, emit, signal) : preparation.outcome;
		await emitExecutionEnd(call, outcome, emit);
		results.push(await emitToolResult(call, outcome, emit));
	}
	return results;
}

/**
 * 同时执行：
 *   1. 按顺序准备每个调用（发出 start 事件、校验参数）；
 *   2. 准备好的调用同时开始执行，谁先完成谁先发出 end 事件；
 *   3. 全部完成后，按调用的顺序生成工具结果消息。
 */
async function executeParallel(
	calls: ToolCall[],
	assistant: AssistantMessage,
	tools: AgentTool[],
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolResultMessage[]> {
	// ① 按顺序准备。准备失败的调用，马上发出 end 事件
	const preparations: Preparation[] = [];
	for (const call of calls) {
		await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
		const preparation = prepareToolCall(call, assistant, tools, signal);
		if (preparation.kind === "failed") await emitExecutionEnd(call, preparation.outcome, emit);
		preparations.push(preparation);
	}

	// ② 同时执行准备好的调用。Promise.all 返回的结果和传入的顺序一致，不管谁先完成
	const outcomes = await Promise.all(
		preparations.map(async (preparation) => {
			if (preparation.kind === "failed") return preparation.outcome;
			const outcome = await runPreparedCall(preparation, emit, signal);
			await emitExecutionEnd(preparation.call, outcome, emit); // 谁先完成，谁先发出 end 事件
			return outcome;
		}),
	);

	// ③ 按调用的顺序生成结果消息
	const results: ToolResultMessage[] = [];
	for (const [index, call] of calls.entries()) {
		results.push(await emitToolResult(call, outcomes[index], emit));
	}
	return results;
}

async function emitExecutionEnd(call: ToolCall, outcome: ToolOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: call.id,
		toolName: call.name,
		result: outcome.result,
		isError: outcome.isError,
	});
}

/** 生成工具结果消息，并发出它的 message_start / message_end 事件 */
async function emitToolResult(call: ToolCall, outcome: ToolOutcome, emit: AgentEventSink): Promise<ToolResultMessage> {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: outcome.result.content,
		details: outcome.result.details,
		isError: outcome.isError,
		timestamp: Date.now(),
	};
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

function errorOutcome(text: string): ToolOutcome {
	return { result: { content: [{ type: "text", text }] }, isError: true };
}

function failed(text: string): Preparation {
	return { kind: "failed", outcome: errorOutcome(text) };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
