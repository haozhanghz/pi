// 第一次调用大模型：把命令行里的问题发给模型，打印回答。
// 运行：node --env-file=.env playground/ask.ts "天空为什么是蓝色的？"

/** OpenAI Chat Completions 接口返回的数据（只列出我们用到的字段） */
interface ChatCompletionResponse {
	model: string;
	choices: {
		message: { role: string; content: string | null };
		finish_reason: string;
	}[];
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// 1. 读取配置。配置放在环境变量里，而不是写死在代码里：换模型不用改代码，key 也不会泄露进 git。
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可以写在 .env 文件里，见 README）");
	process.exit(1);
}

// 2. 读取问题：命令行参数里除了 node 和脚本路径之外的部分
const question = process.argv.slice(2).join(" ");
if (!question) {
	console.error('用法：node --env-file=.env playground/ask.ts "你的问题"');
	process.exit(1);
}

// 3. 发送请求
const startedAt = Date.now();
let response: Response;
try {
	response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: "你是一个乐于助人的助手。回答要简洁。" },
				{ role: "user", content: question },
			],
		}),
	});
} catch (error) {
	// 只有"根本连不上"时 fetch 才会抛异常：地址写错、没联网、服务器没启动
	console.error(`连不上 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

// 4. 检查状态码。401 = key 不对，404 = 地址不对，400 = 请求内容不对（比如模型名写错），429 = 太频繁
if (!response.ok) {
	console.error(`请求失败：HTTP ${response.status}`);
	console.error(await response.text());
	process.exit(1);
}

// 5. 解析响应，取出回答
const data = (await response.json()) as ChatCompletionResponse;
const choice = data.choices?.[0];
if (!choice) {
	console.error("响应里没有 choices：", JSON.stringify(data));
	process.exit(1);
}
console.log(choice.message.content ?? "（模型没有返回文字）");

// 6. 打印用量：大模型按 token 收费，输入和输出分开计价
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const usage = data.usage;
const usageText = usage ? `输入 ${usage.prompt_tokens} tokens，输出 ${usage.completion_tokens} tokens` : "没有返回用量";
console.log(`\n（模型：${data.model}，${usageText}，用时 ${seconds} 秒，停止原因：${choice.finish_reason}）`);
