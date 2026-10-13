// coding agent：能读、写、改文件，还能运行命令。危险的命令执行之前会先问你。
// 为了安全，默认在 playground/workspace 目录里工作（没有就创建），不会碰到你的项目文件。
// 运行（先启动假模型服务器）：
//   node playground/coding-agent.ts
//   然后试试：写入 hello.js 内容 console.log("hello") 然后 运行 node hello.js
//   用真实模型：node --env-file=.env playground/coding-agent.ts --model deepseek/deepseek-chat
//   在当前目录工作（小心！）：node playground/coding-agent.ts --cwd .
//   不再确认危险命令（更小心！）：加上 --yolo
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Agent, type AgentEvent, type BeforeToolCall } from "../src/agent/index.ts";
import { resolveModel } from "../src/ai/index.ts";
import { createCodingTools, type EditToolDetails } from "../src/tools/index.ts";

const { values } = parseArgs({
	options: {
		model: { type: "string", short: "m" },
		cwd: { type: "string" },
		yolo: { type: "boolean" },
	},
});
const model = resolveModel(values.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
const cwd = resolve(values.cwd ?? "playground/workspace");
await mkdir(cwd, { recursive: true });

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

// ---------- 危险命令先确认 ----------

// 和 pi 的示例扩展 permission-gate.ts 一样，用正则表达式识别危险的命令。
// 注意：这只是一道"防止手滑"的保险，不是真正的安全措施（见本章 README）
const DANGEROUS_PATTERNS = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+push\b/i,
	/\bgit\s+reset\s+--hard\b/i,
];

/** 正在等待用户回答的问题。有的话，用户输入的下一行就是答案 */
let pendingAnswer: ((answer: string) => void) | undefined;

function ask(question: string, signal: AbortSignal | undefined): Promise<string> {
	process.stdout.write(question);
	return new Promise<string>((resolve) => {
		pendingAnswer = resolve;
		// 等待回答的时候用户按了 Ctrl+C：不再等了
		signal?.addEventListener("abort", () => resolve(""), { once: true });
	}).finally(() => {
		pendingAnswer = undefined;
	});
}

const confirmDangerousCommands: BeforeToolCall = async ({ toolCall, args }, signal) => {
	if (toolCall.name !== "bash") return undefined;
	const command = String(args.command);
	if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return undefined;
	const answer = await ask(`\n${yellow("[危险命令]")} ${command}\n允许执行吗？(y/N) `, signal);
	return answer.trim().toLowerCase() === "y" ? undefined : { block: true, reason: "用户拒绝执行这个命令。" };
};

const agent = new Agent({
	model,
	tools: createCodingTools(cwd),
	beforeToolCall: values.yolo ? undefined : confirmDangerousCommands,
	// 一个临时的系统提示词。下一章会认真写它
	systemPrompt: `你是一个编程助手，可以读取、创建和修改文件，还可以运行命令。当前工作目录：${cwd}
修改文件之前，先用 read 看清楚文件的内容。修改文件的一部分用 edit，创建新文件或完全重写用 write。回答要简洁。`,
});

// ---------- 显示 ----------

/** 工具参数可能很长（比如要写入的整个文件），只显示概要 */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "write":
			return `${args.path}（${String(args.content ?? "").split("\n").length} 行）`;
		case "edit":
			return `${args.path}（${Array.isArray(args.edits) ? args.edits.length : 0} 处）`;
		case "read": {
			const range = args.offset || args.limit ? ` 从第 ${args.offset ?? 1} 行起，最多 ${args.limit ?? "全部"} 行` : "";
			return `${args.path}${range}`;
		}
		case "ls":
			return String(args.path ?? ".");
		case "bash":
			return `$ ${args.command}`;
		default:
			return JSON.stringify(args);
	}
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function firstLines(value: string, count: number): string {
	const lines = value.split("\n");
	return lines.length > count ? `${lines.slice(0, count).join("\n")}\n…（共 ${lines.length} 行）` : value;
}

/** 命令的输出看最后几行：错误信息和最终结果通常在最后 */
function lastLines(value: string, count: number): string {
	const lines = value.split("\n");
	return lines.length > count ? `…（共 ${lines.length} 行）\n${lines.slice(-count).join("\n")}` : value;
}

/** 给 diff 上色：删除的行红色，新增的行绿色 */
function colorDiff(diff: string): string {
	return diff
		.split("\n")
		.map((line) => (line.startsWith("+") ? green(line) : line.startsWith("-") ? red(line) : dim(line)))
		.join("\n");
}

agent.subscribe((event: AgentEvent) => {
	switch (event.type) {
		case "message_update":
			if (event.event.type === "text_delta") process.stdout.write(event.event.delta);
			else if (event.event.type === "thinking_delta") process.stdout.write(dim(event.event.delta));
			break;
		case "message_end":
			if (event.message.role === "assistant" && event.message.errorMessage) {
				process.stdout.write(red(`\n出错了：${event.message.errorMessage}`));
			}
			break;
		case "tool_execution_start":
			process.stdout.write(`\n${cyan(`> ${event.toolName}`)} ${summarizeArgs(event.toolName, event.args)}\n`);
			break;
		case "tool_execution_end": {
			const text = event.result.content.map((block) => block.text).join("");
			if (event.isError) {
				process.stdout.write(`${red(indent(text))}\n`);
			} else if (event.toolName === "edit") {
				process.stdout.write(`${indent(colorDiff((event.result.details as EditToolDetails).diff))}\n`);
			} else if (event.toolName === "bash") {
				process.stdout.write(`${dim(indent(lastLines(text, 10)))}\n`);
			} else {
				process.stdout.write(`${dim(indent(firstLines(text, 6)))}\n`);
			}
			break;
		}
	}
});

// ---------- 读取输入 ----------
const rl = createInterface({ input: process.stdin, output: process.stdout });
let currentRun: Promise<void> = Promise.resolve();
let closed = false;

async function run(line: string): Promise<void> {
	try {
		await agent.prompt(line);
	} catch (error) {
		console.log(red(`\n程序出错：${error instanceof Error ? error.message : String(error)}`));
	}
	console.log();
	if (!closed) rl.prompt();
}

rl.on("line", (rawLine) => {
	if (pendingAnswer) {
		pendingAnswer(rawLine);
		return;
	}
	const line = rawLine.trim();
	if (line === "") {
		if (!agent.state.isStreaming) rl.prompt();
		return;
	}
	if (!agent.state.isStreaming) currentRun = run(line);
	else if (line.startsWith("+")) agent.followUp(line.slice(1).trim());
	else agent.steer(line);
});

const onInterrupt = () => (agent.state.isStreaming ? agent.abort() : rl.close());
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);
rl.on("close", async () => {
	closed = true;
	await currentRun;
	console.log("\n再见！");
	process.exit(0);
});

console.log(`coding agent 已就绪。模型：${model.provider}/${model.id}`);
console.log(`工作目录：${cwd}`);
if (values.yolo) console.log(yellow("--yolo：危险命令不再确认，直接执行。"));
console.log(dim("运行时：直接输入 = 插话；以 + 开头 = 排队。运行时按 Ctrl+C 打断；空闲时按 Ctrl+C 或 Ctrl+D 退出。"));
rl.setPrompt("\n你> ");
rl.prompt();
