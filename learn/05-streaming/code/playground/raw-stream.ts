// 看看流式响应的原始样子：每收到一块网络数据就打印出来。
// 运行：node --env-file=.env playground/raw-stream.ts "讲一个很短的故事"
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL");
	process.exit(1);
}

const response = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
	body: JSON.stringify({
		model,
		stream: true, // 关键：要求服务器流式返回
		messages: [{ role: "user", content: process.argv.slice(2).join(" ") || "你好" }],
	}),
});
if (!response.ok || !response.body) {
	console.error(`请求失败：HTTP ${response.status}\n${await response.text()}`);
	process.exit(1);
}
console.log("Content-Type:", response.headers.get("content-type"));

const decoder = new TextDecoder();
let index = 0;
// response.body 是一个"字节流"，可以用 for await 一块一块地读
for await (const chunk of response.body) {
	index++;
	const text = decoder.decode(chunk, { stream: true });
	console.log(`----- 第 ${index} 块（${chunk.length} 字节）-----`);
	console.log(JSON.stringify(text)); // 用 JSON.stringify 打印，能看清 \n 等不可见字符
}
