// 第一个真正的 agent：你提一个要求，它自己决定调用哪些工具、调用几次，直到完成。
// 运行（先启动假模型服务器）：
//   node playground/agent-demo.ts
//   然后试试：读取 package.json 然后 计算 23*47
//   用真实模型：node --env-file=.env playground/agent-demo.ts --model deepseek/deepseek-chat
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { type AgentEvent, type AgentTool, type AgentToolResult, runAgentLoop } from "../src/agent/index.ts";
import { getApiKey, type Message, resolveModel } from "../src/ai/index.ts";

const { values } = parseArgs({ options: { model: { type: "string", short: "m" } } });
const model = resolveModel(values.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
const apiKey = getApiKey(model.provider);

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

function text(value: string): AgentToolResult {
	return { content: [{ type: "text", text: value }] };
}

// ---------- 工具 ----------
const getCurrentTime: AgentTool = {
	name: "get_current_time",
	description: "获取当前的日期和时间。",
	parameters: { type: "object", properties: {} },
	async execute() {
		return text(new Date().toLocaleString("zh-CN"));
	},
};

const calculate: AgentTool<{ expression: string }> = {
	name: "calculate",
	description: "计算一个数学表达式，支持 + - * / % 和括号。需要做数学计算时使用，不要自己心算。",
	parameters: {
		type: "object",
		properties: { expression: { type: "string", description: "要计算的表达式，例如 23*47" } },
		required: ["expression"],
	},
	async execute(_id, { expression }) {
		if (!/^[\d\s+\-*/().%]+$/.test(expression)) throw new Error(`不支持的表达式：${expression}`);
		const value: unknown = new Function(`"use strict"; return (${expression});`)();
		return text(String(value));
	},
};

// 一个最简单的读文件工具。里程碑 11 会把它做得完善得多（行数限制、大文件、二进制文件……）
const read: AgentTool<{ path: string }> = {
	name: "read",
	description: "读取一个文本文件的内容。路径相对于当前目录。",
	parameters: {
		type: "object",
		properties: { path: { type: "string", description: "文件路径" } },
		required: ["path"],
	},
	async execute(_id, { path }) {
		return text(await readFile(path, "utf-8"));
	},
};

const tools = [getCurrentTime, calculate, read];

// ---------- 把事件显示出来 ----------
function firstLines(value: string, count: number): string {
	const lines = value.split("\n");
	return lines.length > count ? `${lines.slice(0, count).join("\n")}\n…（共 ${lines.length} 行）` : value;
}

function render(event: AgentEvent): void {
	switch (event.type) {
		case "message_update":
			if (event.event.type === "text_delta") process.stdout.write(event.event.delta);
			else if (event.event.type === "thinking_delta") process.stdout.write(dim(event.event.delta));
			break;
		case "tool_execution_start":
			process.stdout.write(`\n${cyan(`> ${event.toolName}`)} ${dim(JSON.stringify(event.args))}\n`);
			break;
		case "tool_execution_end": {
			const output = firstLines(event.result.content.map((block) => block.text).join(""), 4);
			const indented = output
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n");
			process.stdout.write(`${event.isError ? red(indented) : dim(indented)}\n`);
			break;
		}
		case "message_end":
			if (event.message.role === "assistant" && event.message.errorMessage) {
				process.stdout.write(red(`\n出错了：${event.message.errorMessage}`));
			}
			break;
	}
}

// ---------- 主循环 ----------
const systemPrompt = "你是一个乐于助人的助手，可以使用工具。需要信息时先调用工具获取，不要猜测。回答要简洁。";
const history: Message[] = [];
let current: AbortController | undefined;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const onInterrupt = () => (current ? current.abort() : rl.close());
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);

console.log(`agent 已就绪。模型：${model.provider}/${model.id}，工具：${tools.map((t) => t.name).join("、")}`);
console.log(dim("运行时按 Ctrl+C 打断；空闲时按 Ctrl+C 或 Ctrl+D 退出。"));
rl.setPrompt("\n你> ");
rl.prompt();

for await (const rawLine of rl) {
	const line = rawLine.trim();
	if (line === "") {
		rl.prompt();
		continue;
	}
	current = new AbortController();
	const newMessages = await runAgentLoop(
		[{ role: "user", content: line, timestamp: Date.now() }],
		{ systemPrompt, messages: history, tools },
		{ model, apiKey },
		render,
		current.signal,
	);
	current = undefined;
	history.push(...newMessages);

	// 统计：这次运行调用了几次模型、几次工具、用了多少 token
	let requests = 0;
	let toolCalls = 0;
	let tokens = 0;
	for (const message of newMessages) {
		if (message.role === "assistant") {
			requests++;
			tokens += message.usage.totalTokens;
		} else if (message.role === "toolResult") {
			toolCalls++;
		}
	}
	console.log(dim(`\n（请求模型 ${requests} 次，调用工具 ${toolCalls} 次，共 ${tokens} tokens）`));
	rl.prompt();
}
console.log("\n再见！");
