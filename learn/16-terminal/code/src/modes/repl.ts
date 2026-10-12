// 交互模式（简单版）：一行一行地读取输入，把 agent 的事件打印出来。
// 里程碑 18 会用全屏的终端界面替换它。
// 输入和输出可以替换成别的流，测试时就不需要真的终端。
import { createInterface } from "node:readline";
import type { BeforeToolCall } from "../agent/index.ts";
import type { Message } from "../ai/index.ts";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import type { EditToolDetails } from "../tools/index.ts";

export interface ReplOptions {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	/** 执行危险的命令之前先问用户，默认 true */
	confirmDangerous?: boolean;
	/** 启动时显示的几行信息 */
	banner?: string[];
	/** 启动后立刻依次发送的消息（命令行里给的消息） */
	initialMessages?: string[];
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

// 和 pi 的示例扩展 permission-gate.ts 一样，用正则表达式识别危险的命令。
// 这只是一道"防止手滑"的保险，不是真正的安全措施（见里程碑 12）
const DANGEROUS_PATTERNS = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+push\b/i,
	/\bgit\s+reset\s+--hard\b/i,
];

/** 工具参数可能很长（比如要写入的整个文件），只显示概要 */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
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

function firstLines(text: string, count: number): string {
	const lines = text.split("\n");
	return lines.length > count ? `${lines.slice(0, count).join("\n")}\n…（共 ${lines.length} 行）` : text;
}

function lastLines(text: string, count: number): string {
	const lines = text.split("\n");
	return lines.length > count ? `…（共 ${lines.length} 行）\n${lines.slice(-count).join("\n")}` : text;
}

function colorDiff(diff: string): string {
	return diff
		.split("\n")
		.map((line) => (line.startsWith("+") ? green(line) : line.startsWith("-") ? red(line) : dim(line)))
		.join("\n");
}

/** 恢复会话时，把之前的对话简单地显示一遍（只显示最后 limit 条消息） */
export function formatHistory(messages: Message[], limit = 20): string {
	const lines: string[] = [];
	if (messages.length > limit) lines.push(dim(`…（更早的 ${messages.length - limit} 条消息没有显示）`));
	for (const message of messages.slice(-limit)) {
		if (message.role === "user" && message.content.startsWith("之前的对话已经被压缩成了")) {
			lines.push(dim("\n（更早的对话已经压缩成了一份总结）"));
		} else if (message.role === "user") {
			lines.push(`\n你> ${message.content}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) lines.push(block.text);
				else if (block.type === "toolCall") lines.push(`${cyan(`> ${block.name}`)} ${summarizeArgs(block.name, block.arguments)}`);
			}
			if (message.errorMessage) lines.push(red(`出错了：${message.errorMessage}`));
		}
	}
	return lines.join("\n");
}

/** 运行交互模式，直到用户退出（Ctrl+D 或输入结束） */
export function runReplMode(session: AgentSession, options: ReplOptions = {}): Promise<void> {
	const agent = session.agent;
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const write = (text: string) => output.write(text);
	const rl = createInterface({ input, output });

	let closed = false;
	let currentRun: Promise<void> = Promise.resolve();
	/** 正在等待用户回答的问题。有的话，用户输入的下一行就是答案 */
	let pendingAnswer: ((answer: string) => void) | undefined;

	const ask = (question: string, signal: AbortSignal | undefined): Promise<string> => {
		write(question);
		return new Promise<string>((resolve) => {
			pendingAnswer = resolve;
			signal?.addEventListener("abort", () => resolve(""), { once: true });
		}).finally(() => {
			pendingAnswer = undefined;
		});
	};

	const confirmDangerous: BeforeToolCall = async ({ toolCall, args }, signal) => {
		if (toolCall.name !== "bash") return undefined;
		const command = String(args.command);
		if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return undefined;
		const answer = await ask(`\n${yellow("[危险命令]")} ${command}\n允许执行吗？(y/N) `, signal);
		return answer.trim().toLowerCase() === "y" ? undefined : { block: true, reason: "用户拒绝执行这个命令。" };
	};
	if (options.confirmDangerous ?? true) agent.beforeToolCall = confirmDangerous;

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "compaction_start":
				write(dim(event.reason === "threshold" ? "\n（上下文快满了，正在压缩……）" : "\n（正在压缩上下文……）"));
				break;
			case "compaction_end":
				if (event.result) {
					const { summarizedMessages, tokensBefore, tokensAfter } = event.result;
					write(dim(`（压缩完成：总结了 ${summarizedMessages} 条消息，上下文从约 ${tokensBefore} 降到约 ${tokensAfter} tokens）\n`));
				} else {
					write(red(`（压缩失败：${event.error}）\n`));
				}
				break;
			case "message_update":
				if (event.event.type === "text_delta") write(event.event.delta);
				else if (event.event.type === "thinking_delta") write(dim(event.event.delta));
				break;
			case "message_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					write(red(`\n出错了：${event.message.errorMessage}`));
				}
				break;
			case "tool_execution_start":
				write(`\n${cyan(`> ${event.toolName}`)} ${summarizeArgs(event.toolName, event.args)}\n`);
				break;
			case "tool_execution_end": {
				const text = event.result.content.map((block) => block.text).join("");
				if (event.isError) write(`${red(indent(text))}\n`);
				else if (event.toolName === "edit") write(`${indent(colorDiff((event.result.details as EditToolDetails).diff))}\n`);
				else if (event.toolName === "bash") write(`${dim(indent(lastLines(text, 10)))}\n`);
				else write(`${dim(indent(firstLines(text, 6)))}\n`);
				break;
			}
		}
	});

	const run = async (line: string) => {
		try {
			await session.prompt(line);
		} catch (error) {
			write(red(`\n程序出错：${error instanceof Error ? error.message : String(error)}`));
		}
		write("\n");
		if (!closed) rl.prompt();
	};

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
		if (line === "/compact" || line.startsWith("/compact ")) {
			if (agent.state.isStreaming) {
				write(dim("agent 正在运行，等它结束之后再压缩。\n"));
				return;
			}
			const customInstructions = line.slice("/compact".length).trim() || undefined;
			currentRun = (async () => {
				try {
					const result = await session.compact({ customInstructions });
					if (!result) write(dim("没有可以压缩的内容：对话还很短。\n"));
				} catch {
					// 错误已经通过 compaction_end 事件显示了
				}
				if (!closed) rl.prompt();
			})();
			return;
		}
		if (!agent.state.isStreaming) {
			currentRun = run(line);
		} else if (line.startsWith("+")) {
			agent.followUp(line.slice(1).trim());
			write(dim("（已排队：等它做完手上的事再处理）\n"));
		} else {
			agent.steer(line);
			write(dim("（已插话：当前这一步完成后发给模型）\n"));
		}
	});

	// 运行时按 Ctrl+C 打断；空闲时按 Ctrl+C 退出
	const onInterrupt = () => (agent.state.isStreaming ? agent.abort() : rl.close());
	rl.on("SIGINT", onInterrupt);
	if (input === process.stdin) process.on("SIGINT", onInterrupt);

	for (const line of options.banner ?? []) write(`${line}\n`);
	if (agent.state.messages.length > 0) {
		write(`${dim(`已恢复会话，共 ${agent.state.messages.length} 条消息：`)}\n${formatHistory(agent.state.messages)}\n\n`);
	}
	write(dim("运行时：直接输入 = 插话；以 + 开头 = 排队。/compact 压缩上下文。运行时按 Ctrl+C 打断；空闲时按 Ctrl+C 或 Ctrl+D 退出。\n"));
	rl.setPrompt("\n你> ");
	const initialMessages = options.initialMessages ?? [];
	if (initialMessages.length > 0) {
		currentRun = (async () => {
			for (const message of initialMessages) {
				write(`\n你> ${message}\n`);
				await run(message);
			}
		})();
	} else {
		rl.prompt();
	}

	return new Promise((resolve) => {
		rl.on("close", async () => {
			closed = true;
			await currentRun; // 输入结束了：等当前的任务做完再退出
			unsubscribe();
			process.off("SIGINT", onInterrupt);
			const stats = session.getStats();
			const saved = session.sessionManager.sessionFile;
			write(dim(`\n本次会话：${stats.userMessages} 个问题，调用工具 ${stats.toolCalls} 次，共 ${stats.tokens} tokens，$${stats.cost.toFixed(4)}\n`));
			if (saved && stats.userMessages > 0) write(dim(`会话已保存，下次用 mini-pi -c 继续：${saved}\n`));
			write("再见！\n");
			resolve();
		});
	});
}
