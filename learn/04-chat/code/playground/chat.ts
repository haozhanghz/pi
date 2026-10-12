// 多轮对话：一个有"记忆"的终端聊天程序。
// 运行：node --env-file=.env playground/chat.ts
import { createInterface } from "node:readline";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

interface ChatCompletionResponse {
	choices: { message: { content: string | null }; finish_reason: string }[];
	usage?: Usage;
}

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可以写在 .env 文件里）");
	process.exit(1);
}

/** 让文字在终端里显示成灰色（暗色）。这串奇怪的字符叫 ANSI 转义码，里程碑 16 会详细讲。 */
function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

const systemPrompt = process.env.LLM_SYSTEM ?? "你是一个乐于助人的助手。回答要简洁。";

/** 对话历史。第一条永远是系统提示词。 */
const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
let totalInput = 0;
let totalOutput = 0;

/** 把完整的历史发给模型，返回模型的回答。失败时抛出异常。 */
async function complete(history: ChatMessage[]): Promise<{ text: string; usage?: Usage }> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, messages: history }),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}：${await response.text()}`);
	}
	const data = (await response.json()) as ChatCompletionResponse;
	const choice = data.choices?.[0];
	if (!choice) throw new Error(`响应里没有 choices：${JSON.stringify(data)}`);
	return { text: choice.message.content ?? "", usage: data.usage };
}

/** 处理以 / 开头的命令 */
function handleCommand(command: string): void {
	switch (command) {
		case "/help":
			console.log("可用命令：/history 查看历史，/reset 清空历史，/exit 退出");
			break;
		case "/history":
			for (const [index, message] of messages.entries()) {
				const preview = message.content.length > 40 ? `${message.content.slice(0, 40)}…` : message.content;
				console.log(dim(`${index}. [${message.role}] ${preview}`));
			}
			break;
		case "/reset":
			messages.length = 1; // 只保留第一条：系统提示词
			totalInput = 0;
			totalOutput = 0;
			console.log(dim("（历史已清空，模型将不记得之前的对话）"));
			break;
		case "/exit":
			rl.close();
			break;
		default:
			console.log(`不认识的命令：${command}，输入 /help 查看可用命令`);
	}
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
// 按 Ctrl+C 时关闭输入，循环会随之结束
rl.on("SIGINT", () => rl.close());

console.log(`开始聊天吧！模型：${model}。输入 /help 查看命令，/exit 或 Ctrl+D 退出。`);
rl.setPrompt("你> ");
rl.prompt();

// 一行一行地读取用户输入。用户关闭输入（Ctrl+D、/exit、Ctrl+C）时循环结束。
for await (const rawLine of rl) {
	const line = rawLine.trim();
	if (line === "") {
		rl.prompt();
		continue;
	}
	if (line.startsWith("/")) {
		handleCommand(line);
		if (line !== "/exit") rl.prompt();
		continue;
	}

	messages.push({ role: "user", content: line });
	try {
		const { text, usage } = await complete(messages);
		messages.push({ role: "assistant", content: text });
		console.log(`助手> ${text}`);
		if (usage) {
			totalInput += usage.prompt_tokens;
			totalOutput += usage.completion_tokens;
			console.log(
				dim(
					`（本轮：输入 ${usage.prompt_tokens}、输出 ${usage.completion_tokens} tokens；` +
						`累计：输入 ${totalInput}、输出 ${totalOutput}；历史共 ${messages.length} 条消息）`,
				),
			);
		}
	} catch (error) {
		// 请求失败：撤回刚才那条用户消息，保证历史仍然是"一问一答"交替的合法结构
		messages.pop();
		console.error(`出错了：${error instanceof Error ? error.message : String(error)}`);
	}
	rl.prompt();
}

console.log("\n再见！");
