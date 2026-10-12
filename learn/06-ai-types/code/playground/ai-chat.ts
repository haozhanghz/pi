// 用 src/ai 重写的流式聊天。对比里程碑 05 的 chat-stream.ts：
// 这里完全不知道 OpenAI 的数据格式，也不需要 try/catch——错误会以 error 事件的形式到达。
// 运行：node --env-file=.env playground/ai-chat.ts
import { createInterface } from "node:readline";
import { type Message, type Model, stream } from "../src/ai/index.ts";

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const modelId = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !modelId) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可以写在 .env 文件里）");
	process.exit(1);
}

// 暂时手工描述模型。里程碑 07 会有一张模型表。
const model: Model = {
	id: modelId,
	name: modelId,
	api: "openai-completions",
	provider: "custom",
	baseUrl,
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

const systemPrompt = process.env.LLM_SYSTEM ?? "你是一个乐于助人的助手。回答要简洁。";
const messages: Message[] = [];
let current: AbortController | undefined;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const onInterrupt = () => (current ? current.abort() : rl.close());
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);

console.log(`开始聊天吧！模型：${model.id}。回答时按 Ctrl+C 可以打断，空闲时按 Ctrl+C 或 Ctrl+D 退出。`);
rl.setPrompt("你> ");
rl.prompt();

for await (const rawLine of rl) {
	const line = rawLine.trim();
	if (line === "") {
		rl.prompt();
		continue;
	}

	messages.push({ role: "user", content: line, timestamp: Date.now() });
	current = new AbortController();
	const response = stream(model, { systemPrompt, messages }, { apiKey, signal: current.signal });

	process.stdout.write("助手> ");
	for await (const event of response) {
		switch (event.type) {
			case "thinking_start":
				process.stdout.write(dim("（思考中）"));
				break;
			case "thinking_delta":
				process.stdout.write(dim(event.delta));
				break;
			case "thinking_end":
				process.stdout.write("\n助手> ");
				break;
			case "text_delta":
				process.stdout.write(event.delta);
				break;
		}
	}
	process.stdout.write("\n");
	current = undefined;

	// 不管成功还是失败，最终都会得到一条完整的 AssistantMessage
	const message = await response.result();
	const hasText = message.content.some((block) => block.type === "text" && block.text.length > 0);
	switch (message.stopReason) {
		case "error":
			messages.pop();
			console.error(`出错了：${message.errorMessage}`);
			break;
		case "aborted":
			if (hasText) messages.push(message);
			else messages.pop();
			console.log(dim("（已打断）"));
			break;
		default:
			messages.push(message);
			console.log(
				dim(`（输入 ${message.usage.input}、输出 ${message.usage.output} tokens；停止原因：${message.stopReason}）`),
			);
	}
	rl.prompt();
}

console.log("\n再见！");
