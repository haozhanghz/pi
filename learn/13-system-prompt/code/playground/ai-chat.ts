// 用 src/ai 写的流式聊天，现在可以选择任何服务商的模型。
// 运行：
//   node playground/ai-chat.ts                                # 默认：课程的假模型服务器
//   node playground/ai-chat.ts --model fake-anthropic/fake-model   # 同一个假服务器，换成 Anthropic 协议
//   DEEPSEEK_API_KEY=sk-... node playground/ai-chat.ts --model deepseek/deepseek-chat
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { getApiKey, getProvider, type Message, resolveModel, stream } from "../src/ai/index.ts";

const { values } = parseArgs({ options: { model: { type: "string", short: "m" } } });
const spec = values.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model";

let model: ReturnType<typeof resolveModel>;
try {
	model = resolveModel(spec);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const apiKey = getApiKey(model.provider);
if (!apiKey) {
	const envName = getProvider(model.provider)?.apiKeyEnv ?? "LLM_API_KEY";
	console.error(`没有找到 ${model.provider} 的 API key，请设置环境变量 ${envName}`);
	process.exit(1);
}

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

console.log(`开始聊天吧！模型：${model.provider}/${model.id}（${model.api}）。回答时按 Ctrl+C 可以打断，空闲时按 Ctrl+C 或 Ctrl+D 退出。`);
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
