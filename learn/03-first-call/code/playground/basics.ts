// 第 1~5 节的例子合集。运行：node playground/basics.ts

// ---------- 1. 值、变量和类型 ----------
const model = "deepseek-chat"; // TypeScript 自动推断出类型是 string
let tokens = 0; // 推断为 number
tokens = tokens + 120;
const streaming: boolean = true; // 也可以手动写出类型
console.log("1.", model, tokens, streaming, typeof model, typeof tokens);

let lastError: string | undefined; // 还没有值时是 undefined
console.log("   lastError =", lastError);

// ---------- 2. 运算符与条件 ----------
const contextWindow = 128000;
const reserve = 16384;
const used = 115000;
if (used > contextWindow - reserve) {
	console.log("2. 上下文快满了，需要压缩");
} else {
	console.log("2. 上下文还够用");
}
const label = used > 100000 ? "很多" : "不多"; // 三元表达式：条件 ? 是 : 否
const apiKey = process.env.MY_API_KEY ?? "（没有设置）"; // ?? 提供默认值
console.log("   用量", label, "，API key：", apiKey);

// ---------- 3. 数组 ----------
const toolNames: string[] = ["read", "write", "edit"];
toolNames.push("bash");
console.log("3.", toolNames.length, "个工具，第一个是", toolNames[0], "，最后一个是", toolNames.at(-1));
for (const name of toolNames) {
	console.log("   -", name);
}
const upper = toolNames.map((name) => name.toUpperCase()); // 每个元素变换一下
const short = toolNames.filter((name) => name.length <= 4); // 只保留满足条件的
const hasBash = toolNames.some((name) => name === "bash"); // 有没有至少一个满足
console.log("  ", upper, short, hasBash, toolNames.join(" / "));
const moreTools = [...toolNames, "ls"]; // 展开运算符：复制并追加，原数组不变
console.log("  ", moreTools.length, toolNames.length);

// ---------- 4. 对象 ----------
const message = {
	role: "user",
	content: "帮我看看 package.json",
	timestamp: Date.now(),
};
console.log("4.", message.role, message["content"]);
const edited = { ...message, content: "帮我看看 README.md" }; // 复制一份并修改一个字段
console.log("  ", message.content, "→", edited.content);
console.log("   字段名：", Object.keys(message));

// 对象 → 文本（发给服务器之前要这么做），文本 → 对象（收到服务器回复后要这么做）
const json = JSON.stringify(message);
console.log("   JSON 文本：", json);
const parsed = JSON.parse(json);
console.log("   解析回来：", parsed.content);
console.log("   好看的格式：\n" + JSON.stringify({ model, messages: [message] }, null, 2));

// ---------- 5. 函数 ----------
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// 可选参数（?）和默认参数（= 默认值）
function greet(name: string, greeting = "你好", suffix?: string): string {
	return `${greeting}，${name}${suffix ?? "！"}`;
}

// 箭头函数：另一种写函数的方式，常用于回调
const double = (n: number): number => n * 2;

console.log("5.", estimateTokens("hello world, hello pi"), greet("小明"), greet("Ada", "Hi", "."), double(21));

// 函数也是值，可以作为参数传给别的函数（回调）
function repeat(times: number, action: (index: number) => void): void {
	for (let i = 0; i < times; i++) action(i);
}
repeat(3, (i) => console.log(`   第 ${i + 1} 次`));

// 闭包：函数能"记住"它被创建时能看到的变量
function createIdGenerator(prefix: string): () => string {
	let counter = 0;
	return () => {
		counter++;
		return `${prefix}_${counter}`;
	};
}
const nextId = createIdGenerator("call");
console.log("  ", nextId(), nextId(), nextId());
