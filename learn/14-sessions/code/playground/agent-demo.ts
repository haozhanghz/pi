// 用 Agent 类改写的 agent：运行时可以插话、排队，工具可以同时执行。
// 运行（先启动假模型服务器，建议加 --delay 150，让回复慢一点，方便你在它工作时输入）：
//   node playground/agent-demo.ts
//   node playground/agent-demo.ts --tool-delay 1000              每个工具多等 1 秒，观察并行执行
//   node playground/agent-demo.ts --tool-delay 1000 --sequential 对比：一个一个执行
//   用真实模型：node --env-file=.env playground/agent-demo.ts --model deepseek/deepseek-chat
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Agent, type AgentEvent, type AgentTool, type AgentToolResult } from "../src/agent/index.ts";
import { type Message, resolveModel } from "../src/ai/index.ts";

const { values } = parseArgs({
	options: {
		model: { type: "string", short: "m" },
		"tool-delay": { type: "string" },
		sequential: { type: "boolean" },
	},
});
const model = resolveModel(values.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
const toolDelay = Number(values["tool-delay"] ?? 0);

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

function text(value: string): AgentToolResult {
	return { content: [{ type: "text", text: value }] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 工具（和上一章一样，只是每个工具执行前可以多等一会儿） ----------
const getCurrentTime: AgentTool = {
	name: "get_current_time",
	description: "获取当前的日期和时间。",
	parameters: { type: "object", properties: {} },
	async execute() {
		await sleep(toolDelay);
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
		await sleep(toolDelay);
		if (!/^[\d\s+\-*/().%]+$/.test(expression)) throw new Error(`不支持的表达式：${expression}`);
		const value: unknown = new Function(`"use strict"; return (${expression});`)();
		return text(String(value));
	},
};

const read: AgentTool<{ path: string }> = {
	name: "read",
	description: "读取一个文本文件的内容。路径相对于当前目录。",
	parameters: {
		type: "object",
		properties: { path: { type: "string", description: "文件路径" } },
		required: ["path"],
	},
	async execute(_id, { path }) {
		await sleep(toolDelay);
		return text(await readFile(path, "utf-8"));
	},
};

// ---------- 创建 agent ----------
const agent = new Agent({
	model,
	systemPrompt: "你是一个乐于助人的助手，可以使用工具。需要信息时先调用工具获取，不要猜测。回答要简洁。",
	tools: [getCurrentTime, calculate, read],
	toolExecution: values.sequential ? "sequential" : "parallel",
});

// ---------- 订阅事件，显示出来 ----------
let currentPrompt: Message | undefined;

function firstLines(value: string, count: number): string {
	const lines = value.split("\n");
	return lines.length > count ? `${lines.slice(0, count).join("\n")}\n…（共 ${lines.length} 行）` : value;
}

agent.subscribe((event: AgentEvent) => {
	switch (event.type) {
		case "message_update":
			if (event.event.type === "text_delta") process.stdout.write(event.event.delta);
			else if (event.event.type === "thinking_delta") process.stdout.write(dim(event.event.delta));
			break;
		case "message_end":
			if (event.message.role === "user" && event.message !== currentPrompt) {
				// 不是这次运行一开始的提问：是插话或排队的消息，现在才真正发给模型
				process.stdout.write(`\n${yellow(`[发给模型] ${event.message.content}`)}\n`);
			} else if (event.message.role === "assistant" && event.message.errorMessage) {
				process.stdout.write(red(`\n出错了：${event.message.errorMessage}`));
			}
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
			process.stdout.write(`${cyan(`< ${event.toolName}`)}\n${event.isError ? red(indented) : dim(indented)}\n`);
			break;
		}
	}
});

// ---------- 读取输入 ----------
const rl = createInterface({ input: process.stdin, output: process.stdout });
let currentRun: Promise<void> = Promise.resolve();
let closed = false;

async function run(line: string): Promise<void> {
	const before = agent.state.messages.length;
	const startedAt = Date.now();
	currentPrompt = { role: "user", content: line, timestamp: Date.now() };
	try {
		await agent.prompt(currentPrompt);
	} catch (error) {
		console.log(red(`\n程序出错：${error instanceof Error ? error.message : String(error)}`));
	}

	// 统计：这次运行调用了几次模型、几次工具、用了多少 token、花了多长时间
	let requests = 0;
	let toolCalls = 0;
	let tokens = 0;
	for (const message of agent.state.messages.slice(before)) {
		if (message.role === "assistant") {
			requests++;
			tokens += message.usage.totalTokens;
		} else if (message.role === "toolResult") {
			toolCalls++;
		}
	}
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(dim(`\n（请求模型 ${requests} 次，调用工具 ${toolCalls} 次，共 ${tokens} tokens，用时 ${seconds} 秒）`));
	if (!closed) rl.prompt();
}

rl.on("line", (rawLine) => {
	const line = rawLine.trim();
	if (line === "") {
		if (!agent.state.isStreaming) rl.prompt();
		return;
	}
	if (!agent.state.isStreaming) {
		currentRun = run(line);
	} else if (line.startsWith("+")) {
		agent.followUp(line.slice(1).trim());
		console.log(dim("（已排队：等它做完手上的事再处理）"));
	} else {
		agent.steer(line);
		console.log(dim("（已插话：当前这一步完成后发给模型）"));
	}
});

const onInterrupt = () => (agent.state.isStreaming ? agent.abort() : rl.close());
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);
rl.on("close", async () => {
	// 输入结束了（Ctrl+D，或者管道里的内容读完了）：等当前的任务做完再退出
	closed = true;
	await currentRun;
	console.log("\n再见！");
	process.exit(0);
});

console.log(`agent 已就绪。模型：${model.provider}/${model.id}，工具执行方式：${agent.toolExecution}`);
console.log(dim("运行时：直接输入 = 插话；以 + 开头 = 排队。运行时按 Ctrl+C 打断；空闲时按 Ctrl+C 或 Ctrl+D 退出。"));
rl.setPrompt("\n你> ");
rl.prompt();
