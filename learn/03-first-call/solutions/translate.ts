// 练习答案：翻译器。运行：node --env-file=.env playground/translate.ts "今天天气真好"
// 和 ask.ts 的唯一区别是系统提示词：同一个模型，换一段系统提示词，就变成了另一个"程序"。
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL");
	process.exit(1);
}

const text = process.argv.slice(2).join(" ");
if (!text) {
	console.error('用法：node --env-file=.env playground/translate.ts "要翻译的文字"');
	process.exit(1);
}

const response = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
	body: JSON.stringify({
		model,
		temperature: 0, // 翻译不需要创造性，温度设为 0 让输出更稳定
		messages: [
			{
				role: "system",
				content: "你是一个翻译器。把用户发来的文字翻译成英文。只输出译文，不要任何解释。",
			},
			{ role: "user", content: text },
		],
	}),
});
if (!response.ok) {
	console.error(`请求失败：HTTP ${response.status}\n${await response.text()}`);
	process.exit(1);
}
const data = (await response.json()) as { choices: { message: { content: string | null } }[] };
console.log(data.choices[0]?.message.content ?? "");
