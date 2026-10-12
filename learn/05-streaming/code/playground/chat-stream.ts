// 流式聊天：回答一个字一个字地出现；回答过程中按 Ctrl+C 只打断这一次回答，不退出程序。
// 运行：node --env-file=.env playground/chat-stream.ts
import { createInterface } from "node:readline";
import { parseSSE } from "./sse.ts";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

/** 流式响应里的一个"块"（chunk）。只列出我们用到的字段。 */
interface ChatCompletionChunk {
	choices?: {
		delta?: {
			content?: string | null;
			/** 推理模型（比如 deepseek-reasoner）的思考过程 */
			reasoning_content?: string | null;
		};
		finish_reason?: string | null;
	}[];
	usage?: Usage | null;
}

/** 我们自己定义的"流式片段"：把服务商的格式翻译成更好用的形式 */
type StreamPiece =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "finish"; reason: string }
	| { type: "usage"; usage: Usage };

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可以写在 .env 文件里）");
	process.exit(1);
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

/**
 * 发送流式请求，把服务器发来的事件翻译成 StreamPiece，一个个 yield 出去。
 * 传入的 signal 被触发时，fetch 和读取都会中止（抛出 AbortError）。
 */
async function* streamChat(history: ChatMessage[], signal: AbortSignal): AsyncGenerator<StreamPiece> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			messages: history,
			stream: true,
			stream_options: { include_usage: true }, // 让服务器在最后发一个带用量的块
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}：${await response.text()}`);
	}
	if (!response.body) throw new Error("响应没有内容");

	for await (const event of parseSSE(response.body)) {
		if (event.data === "[DONE]") return; // OpenAI 约定：[DONE] 表示流结束
		const chunk = JSON.parse(event.data) as ChatCompletionChunk;
		if (chunk.usage) yield { type: "usage", usage: chunk.usage };
		const choice = chunk.choices?.[0];
		if (!choice) continue; // 带用量的最后一块，choices 是空数组
		if (choice.delta?.reasoning_content) yield { type: "thinking", text: choice.delta.reasoning_content };
		if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
		if (choice.finish_reason) yield { type: "finish", reason: choice.finish_reason };
	}
}

const systemPrompt = process.env.LLM_SYSTEM ?? "你是一个乐于助人的助手。回答要简洁。";
const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

/** 当前正在进行的请求；没有请求时是 undefined */
let current: AbortController | undefined;

const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Ctrl+C：正在回答时只打断回答；空闲时退出程序 */
function onInterrupt(): void {
	if (current) current.abort();
	else rl.close();
}
rl.on("SIGINT", onInterrupt); // 终端里按 Ctrl+C（readline 接管了键盘）
process.on("SIGINT", onInterrupt); // 通过管道运行时，Ctrl+C 是一个真正的信号

console.log(`开始聊天吧！模型：${model}。回答时按 Ctrl+C 可以打断，空闲时按 Ctrl+C 或 Ctrl+D 退出。`);
rl.setPrompt("你> ");
rl.prompt();

for await (const rawLine of rl) {
	const line = rawLine.trim();
	if (line === "") {
		rl.prompt();
		continue;
	}
	if (line === "/exit") {
		rl.close();
		break;
	}

	messages.push({ role: "user", content: line });
	const controller = new AbortController();
	current = controller;
	let text = "";
	let thinking = false;
	let usage: Usage | undefined;
	let finishReason = "";

	process.stdout.write("助手> ");
	try {
		for await (const piece of streamChat(messages, controller.signal)) {
			switch (piece.type) {
				case "thinking":
					if (!thinking) {
						process.stdout.write(dim("（思考中）"));
						thinking = true;
					}
					process.stdout.write(dim(piece.text));
					break;
				case "text":
					if (thinking) {
						process.stdout.write("\n助手> ");
						thinking = false;
					}
					process.stdout.write(piece.text);
					text += piece.text;
					break;
				case "finish":
					finishReason = piece.reason;
					break;
				case "usage":
					usage = piece.usage;
					break;
			}
		}
		process.stdout.write("\n");
		messages.push({ role: "assistant", content: text });
		const usageText = usage ? `输入 ${usage.prompt_tokens}、输出 ${usage.completion_tokens} tokens` : "没有用量信息";
		console.log(dim(`（${usageText}；停止原因：${finishReason || "未知"}）`));
	} catch (error) {
		process.stdout.write("\n");
		if (controller.signal.aborted) {
			// 被用户打断：已经输出的部分保留在历史里，模型下次能知道自己说到哪了
			if (text.length > 0) messages.push({ role: "assistant", content: text });
			else messages.pop();
			console.log(dim("（已打断）"));
		} else {
			messages.pop();
			console.error(`出错了：${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		current = undefined;
	}
	rl.prompt();
}

console.log("\n再见！");
