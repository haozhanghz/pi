// 练习答案：在 ask.ts 的基础上计算费用。
// 运行：LLM_PRICE_INPUT=2 LLM_PRICE_OUTPUT=8 node --env-file=.env playground/ask-cost.ts "你好"
// 价格的单位是"每百万 token 多少元"，具体数字以服务商官网为准。
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL");
	process.exit(1);
}
const priceInput = Number(process.env.LLM_PRICE_INPUT ?? "0");
const priceOutput = Number(process.env.LLM_PRICE_OUTPUT ?? "0");

const question = process.argv.slice(2).join(" ") || "用一句话介绍你自己";
const response = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
	body: JSON.stringify({ model, messages: [{ role: "user", content: question }] }),
});
if (!response.ok) {
	console.error(`请求失败：HTTP ${response.status}\n${await response.text()}`);
	process.exit(1);
}
const data = (await response.json()) as {
	choices: { message: { content: string | null } }[];
	usage?: { prompt_tokens: number; completion_tokens: number };
};
console.log(data.choices[0]?.message.content ?? "");

const input = data.usage?.prompt_tokens ?? 0;
const output = data.usage?.completion_tokens ?? 0;
// 价格是"每百万 token"，所以要除以 1,000,000
const cost = (input * priceInput + output * priceOutput) / 1_000_000;
console.log(`\n输入 ${input} tokens + 输出 ${output} tokens，约 ${cost.toFixed(6)} 元`);
