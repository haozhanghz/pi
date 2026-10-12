// 用 fetch 发 HTTP 请求。
// 先在另一个终端启动假模型服务器：node <课程目录>/learn/tools/fake-llm/server.ts
// 然后运行：node playground/fetch-demo.ts
const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:4000/v1";

// 1. 最简单的 GET 请求
const response = await fetch(`${baseUrl}/models`);
console.log("状态码：", response.status, response.ok ? "（成功）" : "（失败）");
console.log("内容类型：", response.headers.get("content-type"));
const body: unknown = await response.json(); // 把响应体按 JSON 解析
console.log("响应体：", JSON.stringify(body, null, 2));

// 2. 一个会失败的请求：地址写错了。注意：fetch 不会因为 404 抛异常，要自己检查 response.ok
const bad = await fetch(`${baseUrl}/not-exist`);
console.log("\n错误地址的状态码：", bad.status, "ok =", bad.ok);
console.log("错误信息：", await bad.text());

// 3. 连不上服务器时，fetch 才会抛异常
try {
	await fetch("http://localhost:1/never");
} catch (error) {
	console.log("\n连不上服务器：", error instanceof Error ? error.message : String(error));
}
