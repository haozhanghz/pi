// 手动完成一次"模型调用工具"的完整往返：提问 → 模型要求调用工具 → 我们执行工具 → 把结果发回 → 模型回答。
// 运行（先启动假模型服务器）：
//   node playground/tool-demo.ts "现在几点 同时 计算 23*47"
//   node playground/tool-demo.ts "现在几点 然后 计算 23*47"     # 看看只做一次往返有什么问题
//   node --env-file=.env playground/tool-demo.ts --model deepseek/deepseek-chat "现在几点了？顺便算一下 23*47"
import { parseArgs } from "node:util";
import {
	type AssistantMessage,
	getApiKey,
	type Message,
	resolveModel,
	stream,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "../src/ai/index.ts";

const { values, positionals } = parseArgs({
	options: { model: { type: "string", short: "m" } },
	allowPositionals: true,
});
const model = resolveModel(values.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
const apiKey = getApiKey(model.provider);
const question = positionals.join(" ") || "现在几点 同时 计算 23*47";

// ---------- 1. 定义工具：告诉模型"你可以调用这些工具" ----------
const tools: Tool[] = [
	{
		name: "get_current_time",
		description: "获取当前的日期和时间。用户问到时间、日期、星期几时使用。",
		parameters: { type: "object", properties: {}, required: [] },
	},
	{
		name: "calculate",
		description: "计算一个数学表达式，支持 + - * / % 和括号。需要做数学计算时使用，不要自己心算。",
		parameters: {
			type: "object",
			properties: { expression: { type: "string", description: "要计算的表达式，例如 23*47" } },
			required: ["expression"],
		},
	},
];

// ---------- 2. 真正执行工具的代码：它运行在我们的程序里，不在模型那边 ----------
function runTool(call: ToolCall): { text: string; isError: boolean } {
	switch (call.name) {
		case "get_current_time":
			return { text: new Date().toLocaleString("zh-CN"), isError: false };
		case "calculate": {
			const expression = call.arguments.expression;
			if (typeof expression !== "string") return { text: "参数 expression 必须是字符串", isError: true };
			// 安全检查：只允许数字、运算符、括号和空格。永远不要直接执行来路不明的代码！
			if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
				return { text: `不支持的表达式：${expression}`, isError: true };
			}
			try {
				const value: unknown = new Function(`"use strict"; return (${expression});`)();
				return { text: String(value), isError: false };
			} catch (error) {
				return { text: `计算出错：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		}
		default:
			return { text: `没有这个工具：${call.name}`, isError: true };
	}
}

// ---------- 3. 发一次请求，把模型的回复（包括工具调用）流式地打印出来 ----------
async function ask(messages: Message[]): Promise<AssistantMessage> {
	const response = stream(model, { systemPrompt: "你是一个乐于助人的助手。", messages, tools }, { apiKey });
	for await (const event of response) {
		switch (event.type) {
			case "text_delta":
				process.stdout.write(event.delta);
				break;
			case "toolcall_start": {
				const block = event.partial.content[event.contentIndex];
				process.stdout.write(`\n[调用 ${block.type === "toolCall" ? block.name : "?"}] `);
				break;
			}
			case "toolcall_delta":
				process.stdout.write(event.delta); // 参数 JSON 是一点一点到达的
				break;
		}
	}
	process.stdout.write("\n");
	return response.result();
}

const messages: Message[] = [{ role: "user", content: question, timestamp: Date.now() }];
console.log(`模型：${model.provider}/${model.id}\n问题：${question}\n`);

console.log("========== 第 1 次请求 ==========");
const first = await ask(messages);
messages.push(first);
if (first.stopReason !== "toolUse") {
	const reason = first.errorMessage ? `${first.stopReason}：${first.errorMessage}` : first.stopReason;
	console.log(`\n模型没有调用工具（停止原因：${reason}）`);
	process.exit(0);
}

console.log("\n========== 执行工具 ==========");
for (const block of first.content) {
	if (block.type !== "toolCall") continue;
	const result = runTool(block);
	console.log(`${block.name}(${JSON.stringify(block.arguments)}) → ${result.isError ? "出错：" : ""}${result.text}`);
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: block.id, // 用 id 告诉模型：这是哪一次调用的结果
		toolName: block.name,
		content: [{ type: "text", text: result.text }],
		isError: result.isError,
		timestamp: Date.now(),
	};
	messages.push(toolResult);
}

console.log("\n========== 第 2 次请求（带上工具结果） ==========");
const second = await ask(messages);
messages.push(second);
if (second.stopReason === "toolUse") {
	console.log("\n模型还想继续调用工具！但这个脚本只做一次往返，没法继续了。");
	console.log("要让模型想调用几次就调用几次，我们需要一个循环——这就是下一章的 Agent Loop。");
}
console.log(`\n对话里一共有 ${messages.length} 条消息：${messages.map((m) => m.role).join(" → ")}`);
