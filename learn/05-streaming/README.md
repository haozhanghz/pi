# 里程碑 05：流式输出

> 目标：亲手解析大模型的流式响应（SSE），让回答一个字一个字地出现；回答过程中可以随时打断。
>
> 完成后你将拥有：`playground/sse.ts`——一个健壮的 SSE 解析器；`playground/chat-stream.ts`——流式版本的聊天程序，支持显示推理模型的"思考过程"，按 Ctrl+C 只打断当前回答。

## 你将学到

- 流式响应的协议：SSE（Server-Sent Events）
- 网络数据是"一块一块"到达的，块的边界是任意的
- 三层解析：字节 → 文字 → 行 → 事件
- UTF-8 编码和"被切成两半的汉字"
- 把服务商的数据格式翻译成我们自己的事件类型
- 用 `AbortController` 打断一次请求，并正确处理半截的回答

---

## 1. 问题：等得太久

用上一章的 `chat.ts` 让真实模型"写一篇 800 字的作文"。你会盯着空白的屏幕等十几秒，然后整篇作文突然一下子出现。在这十几秒里，你不知道程序是在工作还是卡死了。

对 coding agent 来说更是如此：模型经常要写一大段代码，用户需要**实时**看到它在写什么，必要时立刻打断它。

**解决**：请求时加上 `"stream": true`，服务器就会**边生成边发送**，每生成几个字就发一小段过来。

## 2. 流式响应长什么样

先别急着写解析代码，看看原始数据。[code/playground/raw-stream.ts](code/playground/raw-stream.ts) 发送一个流式请求，然后把收到的每一块网络数据原样打印出来：

```ts
const response = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
	body: JSON.stringify({
		model,
		stream: true,
		messages: [{ role: "user", content: process.argv.slice(2).join(" ") || "你好" }],
	}),
});

const decoder = new TextDecoder();
let index = 0;
for await (const chunk of response.body) {
	index++;
	const text = decoder.decode(chunk, { stream: true });
	console.log(`----- 第 ${index} 块（${chunk.length} 字节）-----`);
	console.log(JSON.stringify(text));
}
```

`response.body` 是响应体的**字节流**（`ReadableStream`），可以用 `for await` 一块一块地读，每一块是一个 `Uint8Array`（字节数组）。

运行它（用假模型服务器或真实模型都行）：

```bash
node --env-file=.env playground/raw-stream.ts "讲一个很短的故事"
```

```
Content-Type: text/event-stream; charset=utf-8
----- 第 1 块（189 字节）-----
"data: {\"id\":\"chatcmpl_cs59\",\"object\":\"chat.completion.chunk\",...,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n"
----- 第 2 块（176 字节）-----
"data: {...\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你说\"},\"finish_reason\":null}]}\n\n"
----- 第 3 块（182 字节）-----
"data: {...\"choices\":[{\"index\":0,\"delta\":{\"content\":\"的是：「\"},\"finish_reason\":null}]}\n\n"
...
"data: {...\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
"data: [DONE]\n\n"
```

几个观察：

1. `Content-Type` 是 `text/event-stream`，这就是 **SSE（Server-Sent Events，服务器推送事件）** 协议。它是一种非常简单的文本协议。
2. 每个事件形如 `data: 一段JSON` 加上**一个空行**（`\n\n`）。
3. 每段 JSON 叫一个 **chunk（块）**，里面的 `delta`（增量）是"**这次新增的内容**"，而不是到目前为止的全部内容。把所有 `delta.content` 依次拼起来，才是完整的回答。
4. 最后一块带有 `finish_reason`，然后是一个特殊的 `data: [DONE]`，表示流结束了。

### SSE 的规则

SSE 的完整规则只有几条：

- 一行一个字段，格式是 `字段名: 值`。最常用的字段是 `data` 和 `event`。
- 冒号后面如果有一个空格，这个空格不算内容。
- **空行**表示一个事件结束。
- 以冒号开头的行是**注释**，服务器常用它来做"心跳"（防止连接因为长时间没数据被断开），直接忽略。
- 一个事件可以有多行 `data`，它们用换行符连接。

```
event: message        ← 事件类型（可选；OpenAI 不用，Anthropic 会用）
data: 第一行          ← 数据
data: 第二行          ← 多行数据用 \n 连起来："第一行\n第二行"
                      ← 空行：事件结束
: 这是一行注释         ← 忽略
```

## 3. 为什么不能简单地按 \n\n 切开

看上面的输出，似乎每一块网络数据正好是一个完整的事件，那直接 `text.split("\n\n")` 不就行了吗？

**不行。** 那只是假模型服务器"太规矩"了。真实的网络中，数据块的边界是**任意**的：

- 一块里可能有好几个事件；
- 一个事件可能被切成好几块；
- 甚至**一个汉字都可能被切成两半**。

假模型服务器的 `--chop` 选项会模拟这种情况，把数据切成随机大小的碎片：

```bash
node ~/pi/learn/tools/fake-llm/server.ts --chop
```

再运行 `raw-stream.ts`，你会看到类似这样的输出：

```
----- 第 1 块（23 字节）-----
"data: {\"id\":\"chatcmp"
----- 第 2 块（7 字节）-----
"l_x8k2\""
...
----- 第 15 块（31 字节）-----
"\"content\":\"你说\"},\"fini"
```

如果你的代码假设"一块就是一个事件"，在真实环境里就会时不时地出错——而且是那种很难复现的、偶发的错误。所以我们要按照协议，一层一层地正确解析。

## 4. 第一层：字节 → 文字（以及被切开的汉字）

计算机存储和传输的都是**字节**。文字要通过**编码**变成字节，最常用的编码是 **UTF-8**：英文字母占 1 个字节，大部分汉字占 3 个字节。

[code/playground/utf8-split.ts](code/playground/utf8-split.ts) 演示了汉字被切开的后果：

```ts
const bytes = new TextEncoder().encode("你好");
console.log("「你好」的 UTF-8 编码一共", bytes.length, "个字节：", Array.from(bytes));

const part1 = bytes.slice(0, 4);   // "你"的 3 个字节 + "好"的第 1 个字节
const part2 = bytes.slice(4);      // "好"的后 2 个字节

console.log("单独解码：", new TextDecoder().decode(part1), "+", new TextDecoder().decode(part2));

const decoder = new TextDecoder();
const text = decoder.decode(part1, { stream: true }) + decoder.decode(part2, { stream: true }) + decoder.decode();
console.log("流式解码：", text);
```

```
「你好」的 UTF-8 编码一共 6 个字节： [ 228, 189, 160, 229, 165, 189 ]
单独解码： 你� + ��
流式解码： 你好
```

单独解码时，不完整的字节被替换成了 `�`（叫"替换字符"），乱码就是这么来的。

**解决**：用**同一个** `TextDecoder`，并传入 `{ stream: true }`。它的意思是"后面还有数据"，解码器会把末尾不完整的字节先存起来，等下一块到了再拼上。全部结束后再调用一次不带参数的 `decoder.decode()`，把残留的字节冲刷出来。

```ts
async function* decodeText(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	for await (const chunk of bytes) {
		const text = decoder.decode(chunk, { stream: true });
		if (text.length > 0) yield text;
	}
	const rest = decoder.decode();
	if (rest.length > 0) yield rest;
}
```

> 这个问题对英文用户几乎不会出现（英文字母都是单字节的），但对中文用户是实实在在的 bug。很多用英文环境开发的程序，中文输出偶尔会出现乱码，原因就在这里。

## 5. 第二层：文字 → 行

文字片段可能在任意位置切开，所以要用一个 **buffer（缓冲区）** 攒着，只有遇到换行符，才把完整的一行交出去。这正是里程碑 02 练习 3 的 `lines` 函数，这里再加上对 `\r\n` 换行的兼容（有些服务器用它）：

```ts
async function* splitLines(texts: AsyncIterable<string>): AsyncGenerator<string> {
	let buffer = "";
	for await (const text of texts) {
		buffer += text;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			let line = buffer.slice(0, newline);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			yield line;
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}
```

注意 `while` 循环：一次收到的文字里可能有好几个换行符，要全部处理完。最后剩下的、没有换行符结尾的部分也要交出去。

## 6. 第三层：行 → 事件

按照第 2 节的 SSE 规则，把行组装成事件：

```ts
export interface SseEvent {
	event?: string;
	data: string;
}

export async function* parseSSE(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
	let event: string | undefined;
	let dataLines: string[] = [];

	for await (const line of splitLines(decodeText(bytes))) {
		if (line === "") {
			if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
			event = undefined;
			dataLines = [];
			continue;
		}
		if (line.startsWith(":")) continue;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		if (field === "data") dataLines.push(value);
		else if (field === "event") event = value;
	}

	if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
}
```

三个生成器像管道一样串起来：

```
response.body ──▶ decodeText ──▶ splitLines ──▶ parseSSE ──▶ { event, data }
   字节块            文字片段         完整的行          完整的事件
```

每一层只做一件事，并且只依赖上一层的输出。这种"管道"结构让每一层都容易理解、容易单独测试。

把这三个函数放进 `playground/sse.ts`，只导出 `parseSSE`。完整代码：[code/playground/sse.ts](code/playground/sse.ts)。

## 7. 把 chunk 翻译成我们自己的事件

SSE 解析器只负责把字节变成 `{ event, data }`，它不知道 data 里是什么。下一步是解析 OpenAI 的 chunk，并把它翻译成我们自己的、更好用的格式：

```ts
interface ChatCompletionChunk {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
		};
		finish_reason?: string | null;
	}[];
	usage?: Usage | null;
}

type StreamPiece =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "finish"; reason: string }
	| { type: "usage"; usage: Usage };
```

为什么要翻译一次，而不是直接在界面代码里处理 chunk？因为不同服务商的格式差别很大（下一个里程碑你就会看到 Anthropic 的格式完全不同）。如果界面代码直接处理 OpenAI 的 chunk，换一个服务商就得改界面。翻译成统一的 `StreamPiece`，界面就只认识 `StreamPiece`，不管背后是谁。

这就是 pi 的 `ai` 包的核心思想，下一章我们会把它做完整。

```ts
async function* streamChat(history: ChatMessage[], signal: AbortSignal): AsyncGenerator<StreamPiece> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			messages: history,
			stream: true,
			stream_options: { include_usage: true },
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}：${await response.text()}`);
	}
	if (!response.body) throw new Error("响应没有内容");

	for await (const event of parseSSE(response.body)) {
		if (event.data === "[DONE]") return;
		const chunk = JSON.parse(event.data) as ChatCompletionChunk;
		if (chunk.usage) yield { type: "usage", usage: chunk.usage };
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		if (choice.delta?.reasoning_content) yield { type: "thinking", text: choice.delta.reasoning_content };
		if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
		if (choice.finish_reason) yield { type: "finish", reason: choice.finish_reason };
	}
}
```

几个细节：

- **用量**：流式模式下，默认不返回用量。加上 `stream_options: { include_usage: true }`，服务器会在最后额外发一个 chunk，`choices` 是空数组，`usage` 里是用量。所以 `choices?.[0]` 可能是 `undefined`，要跳过。
- **`[DONE]`** 不是 JSON，必须在 `JSON.parse` 之前判断，否则会报错。
- **思考过程**：DeepSeek-R1 这类"推理模型"在回答之前会先"思考"，思考的内容放在 `reasoning_content` 字段里。我们把它作为单独的 `thinking` 片段，界面上用灰色显示。
- **`signal`** 传给了 `fetch`，触发时请求会被中止，正在进行的 `for await` 会抛出一个 `AbortError`。

## 8. 打断一次回答

**需求**：模型正在长篇大论，用户按 Ctrl+C，应该只打断**这一次回答**，然后回到"你>"等待输入；如果没有在回答，Ctrl+C 才退出程序。

**解决**：每次请求创建一个新的 `AbortController`，用一个变量 `current` 记住它：

```ts
let current: AbortController | undefined;

function onInterrupt(): void {
	if (current) current.abort();
	else rl.close();
}
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);
```

为什么要监听两个地方？在终端里直接运行时，readline 接管了键盘，Ctrl+C 变成了 readline 的 `SIGINT` **事件**；通过管道运行时（比如检查脚本），Ctrl+C 是发给进程的 `SIGINT` **信号**。两个都接住，才能在两种情况下都正常工作。

主循环里：

```ts
messages.push({ role: "user", content: line });
const controller = new AbortController();
current = controller;
let text = "";

try {
	for await (const piece of streamChat(messages, controller.signal)) {
		// ……根据 piece.type 显示，text 累积回答……
	}
	messages.push({ role: "assistant", content: text });
} catch (error) {
	if (controller.signal.aborted) {
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
```

被打断时，已经输出的半截回答怎么办？两种选择都说得通：

- **保留**：模型下一轮能看到自己说到哪儿了，用户说"继续"它就能接着说。我们选择这种。
- **丢弃**：就当这一轮没发生过。

但有一条规则不能违反：**如果一个字都没收到，就把用户消息撤回**（上一章讲过，保持一问一答的结构）。

另外注意 `finally`：无论成功、失败还是被打断，都要把 `current` 清空，否则下次按 Ctrl+C 会去"打断"一个已经结束的请求，而不是退出程序。

### 思考过程要不要保存？

注意 `text` 只累积了 `text` 片段，没有包含 `thinking`。思考过程只显示给用户看，**不放进历史**。DeepSeek 的文档明确说明，下一轮请求不需要（也不应该）把上一轮的思考内容发回去。

完整代码：[code/playground/chat-stream.ts](code/playground/chat-stream.ts)。

## 9. 运行

```bash
node --env-file=.env playground/chat-stream.ts
```

- 让模型写一篇长文章，看文字逐渐出现。
- 写到一半按 Ctrl+C，看它停下来并回到"你>"。再说"继续"，看模型能否接着写（因为我们保留了半截回答）。
- 用假模型服务器的 `--chop` 模式运行，确认中文没有乱码。
- 如果你的服务商有推理模型（比如 `deepseek-reasoner`），把 `LLM_MODEL` 换成它，看看灰色的思考过程。

## 10. 接口约定与自动检查

- 文件：`playground/sse.ts`（导出 `parseSSE`）和 `playground/chat-stream.ts`。
- `chat-stream.ts` 的行为在里程碑 04 的基础上增加：
  - 请求体带 `"stream": true`；
  - 回答逐步输出，中文不能出现乱码；
  - 思考过程（`reasoning_content`）可以显示，但不保存进历史；
  - 回答过程中收到 `SIGINT`（Ctrl+C），打断这一次回答，程序回到 `你>` 提示符继续运行。

```bash
node --test learn/05-streaming/check.test.ts                  # 检查参考答案
MY_PI=~/my-pi node --test learn/05-streaming/check.test.ts    # 检查你的项目
```

检查脚本使用 `--chop` 模式的假模型服务器，所以只有真正正确的解析器才能通过。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 中文偶尔出现 `�` 乱码 | 每块数据单独创建 `TextDecoder` 解码，或者没有传 `{ stream: true }` |
| `SyntaxError: Unexpected token` 来自 `JSON.parse` | 把不完整的行拿去解析了（没有用 buffer 攒行）；或者把 `[DONE]` 拿去解析了 |
| 回答最后少了几个字 | 流结束时没有处理 buffer 里剩下的内容 |
| 文字一次性出现，没有流式效果 | 忘了 `stream: true`；或者用了 `console.log`（每次都换行），应该用 `process.stdout.write` |
| 没有用量信息 | 没加 `stream_options: { include_usage: true }`（有些服务商不支持这个参数，那就只能没有了） |
| 按一次 Ctrl+C 打断后，再按 Ctrl+C 没法退出 | 没有在 `finally` 里清空 `current` |

## 12. 练习

1. **速度统计**：打印每次回答的"首字延迟"（从发出请求到收到第一个文字片段的时间）和"输出速度"（每秒多少个字）。首字延迟（time to first token）是衡量模型服务体验的重要指标。
2. **等待动画**：在收到第一个片段之前，显示一个转动的小动画 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`（提示：`setInterval` 每 80 毫秒用 `\r` 回到行首重新绘制，收到第一个片段时 `clearInterval`）。
3. **给 parseSSE 写测试**：写一个 `test/sse.test.ts`，用一个异步生成器模拟"被切得乱七八糟的字节块"，断言 `parseSSE` 输出正确的事件。至少覆盖：一个事件被切成多块、一块包含多个事件、汉字被切开、注释行、多行 data、`\r\n` 换行、最后一个事件没有空行结尾。参考答案：[code/test/sse.test.ts](code/test/sse.test.ts)。
4. **支持单独的 `\r` 换行**：SSE 规范允许 `\r`、`\n`、`\r\n` 三种换行。修改 `splitLines` 支持单独的 `\r`。（提示：小心 `\r` 恰好在一块的末尾、`\n` 在下一块开头的情况。）

## 13. 自测问题

1. 流式响应里的 `delta` 是什么？怎么得到完整的回答？
2. 为什么不能直接用 `split("\n\n")` 解析 SSE？
3. `TextDecoder` 的 `{ stream: true }` 解决了什么问题？
4. `parseSSE` 由哪三层组成？每层的输入和输出是什么？
5. 为什么要把 OpenAI 的 chunk 翻译成我们自己的 `StreamPiece`？
6. 用户打断回答时，如果一个字都没收到，为什么要撤回用户消息？

<details>
<summary>参考答案</summary>

1. 增量：这一块新增的内容。把所有 delta 依次拼接起来就是完整回答。
2. 网络数据块的边界是任意的，一个事件可能被切成多块，一块也可能包含多个事件，甚至一个汉字都可能被切开。
3. 多字节字符（如汉字）被切到两块数据里时，解码器会暂存不完整的字节，等下一块到来再拼接，避免乱码。
4. `decodeText`：字节块 → 文字片段；`splitLines`：文字片段 → 完整的行；`parseSSE`：行 → 事件 `{ event, data }`。
5. 不同服务商格式不同。统一成自己的格式后，界面等上层代码不需要关心背后是哪家服务商。
6. 保持历史"一问一答"交替的合法结构，否则下次请求会出现两条相邻的 user 消息。

</details>

## 14. 对照 pi 源码

打开 [packages/ai/src/api/anthropic-messages.ts](../../packages/ai/src/api/anthropic-messages.ts)，搜索 `iterateSseMessages`。你会看到 pi 手写的 SSE 解析器，几乎和我们的一模一样：

```ts
async function* iterateSseMessages(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";
	// ……
	const { value, done } = await reader.read();
	buffer += decoder.decode(value, { stream: true });
	let consumed = consumeLine(buffer);
	while (consumed) {
		buffer = consumed.rest;
		const event = decodeSseLine(consumed.line, state);
		if (event) yield event;
		consumed = consumeLine(buffer);
	}
	// ……
}
```

再看 `decodeSseLine`：空行时 `flushSseEvent`（交出一个事件），冒号开头的行忽略，`event` 和 `data` 字段分别保存，冒号后的一个空格去掉——和我们的规则逐条对应。它的 `consumeLine` 还支持单独的 `\r` 换行，正是练习 4。

pi 的 OpenAI 兼容适配器（[openai-completions.ts](../../packages/ai/src/api/openai-completions.ts)）用的是 OpenAI 官方 SDK，SDK 内部做了同样的 SSE 解析。在那个文件里搜索 `for await (const chunk of openaiStream)`，你会看到 pi 处理 chunk 的代码：读取 `choice.delta.content` 追加到文字块、读取 `reasoning_content` 追加到思考块、读取 `finish_reason`——和我们的 `streamChat` 是同一回事，只是更完整。

## 15. 闭卷挑战

不看资料，从零写出 `sse.ts` 的三层解析器，并让检查脚本全部通过（尤其是 `--chop` 模式下的中文测试）。30 分钟内完成，你就真正掌握了流式解析。

---

上一步：[里程碑 04：多轮对话](../04-chat/README.md) · 下一步：[里程碑 06：统一的消息与事件流](../06-ai-types/README.md)
