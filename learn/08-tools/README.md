# 里程碑 08：工具调用

> 目标：理解"工具调用"到底是怎么回事，让 ai 层支持工具，并手动完成一次"模型调用工具 → 程序执行 → 模型根据结果回答"的完整往返。
>
> 完成后你将拥有：支持工具调用的三个适配器、能解析"写了一半的 JSON"的 `parsePartialJson`，以及演示程序 `playground/tool-demo.ts`。

```
$ node playground/tool-demo.ts "现在几点 同时 计算 23*47"
========== 第 1 次请求 ==========
我来查一下当前时间。我来计算 23*47。
[调用 get_current_time] {}
[调用 calculate] {"expression":"23*47"}

========== 执行工具 ==========
get_current_time({}) → 2026/10/12 22:07:20
calculate({"expression":"23*47"}) → 1081

========== 第 2 次请求（带上工具结果） ==========
完成！一共执行了 2 个工具调用，结果如下：……
```

## 你将学到

- 工具调用的本质：模型**请求**调用，程序**执行**
- 用 JSON Schema 描述工具的参数
- 两种协议里工具调用的格式
- 流式输出时，工具参数是"一点一点"到达的 JSON，怎么提前解析
- 工具调用和工具结果必须一一配对
- 推理模型在工具循环中的特殊要求

---

## 1. 问题：模型只会"说"，不会"做"

到目前为止，大模型只能根据训练时学到的知识生成文字。它做不到：

- 知道现在几点（它没有时钟）；
- 可靠地做数学计算（它是在"预测下一个字"，而不是在计算）；
- 读你电脑上的文件、运行命令、上网查资料。

而一个 coding agent 的全部价值，恰恰在于**动手**：读代码、改代码、跑测试。

## 2. 解决：工具调用

**工具调用（tool calling，也叫 function calling）** 的思路非常简单：

1. 程序在请求里告诉模型："你可以使用这些工具，每个工具叫什么名字、是做什么的、需要什么参数。"
2. 模型如果觉得需要用工具，就**不直接回答**，而是返回一段结构化的数据："请帮我调用 `calculate`，参数是 `{"expression": "23*47"}`。"
3. 程序收到后，**自己**执行这个函数，得到结果 `1081`。
4. 程序把结果发回给模型（作为一条新消息）。
5. 模型看到结果，给出最终回答："23×47 = 1081。"

```
你的程序                                          模型
   │                                                │
   │── 问题 + 工具列表 ──────────────────────────────▶│
   │◀── "请调用 calculate({expression:'23*47'})" ─────│   stopReason = toolUse
   │                                                │
   │  执行 calculate("23*47") → 1081                 │
   │                                                │
   │── 历史 + 工具结果 "1081" ────────────────────────▶│
   │◀── "23×47 = 1081。" ─────────────────────────────│   stopReason = stop
```

请牢牢记住最关键的一点：**模型自己从来不执行任何东西。** 它只是输出了一段文字（格式化的 JSON），说"我想调用这个函数，参数是这些"。执不执行、怎么执行，完全由**你的程序**决定。

这带来两个重要的推论：

- **安全**：模型可能请求做危险的事（比如删除文件），你的程序有机会拦住它（里程碑 12）。
- **灵活**：工具可以是任何东西——读文件、查数据库、调用其他 API、甚至问用户一个问题。

## 3. 定义工具

一个工具由三部分组成：

```ts
export interface Tool {
	name: string;
	description: string;
	parameters: JsonSchema;
}
```

例子：

```ts
const calculate: Tool = {
	name: "calculate",
	description: "计算一个数学表达式，支持 + - * / % 和括号。需要做数学计算时使用，不要自己心算。",
	parameters: {
		type: "object",
		properties: {
			expression: { type: "string", description: "要计算的表达式，例如 23*47" },
		},
		required: ["expression"],
	},
};
```

### 3.1 description 是给模型看的说明书

模型完全靠 `description` 判断"什么时候该用这个工具、怎么用"。好的描述要说清楚：

- 这个工具做什么；
- 什么时候应该用它（甚至什么时候**不**应该用）；
- 参数的格式和例子。

对比一下：

| 不好的描述 | 好的描述 |
| --- | --- |
| `"计算"` | `"计算一个数学表达式，支持 + - * / % 和括号。需要做数学计算时使用，不要自己心算。"` |
| `"读文件"` | `"读取文件内容。超过 2000 行时只返回前 2000 行，用 offset 参数继续读。修改文件之前，先用它看清楚文件的内容。"` |

写工具描述是 agent 开发里很重要的一门手艺。pi 的每个工具描述都经过反复打磨。

### 3.2 JSON Schema：描述参数的格式

`parameters` 用 **JSON Schema** 描述参数的结构。它本身就是一个 JSON 对象，我们只需要其中最常用的几个关键字：

| 关键字 | 含义 | 例子 |
| --- | --- | --- |
| `type` | 类型 | `"object"`、`"string"`、`"number"`、`"integer"`、`"boolean"`、`"array"` |
| `properties` | 对象有哪些字段，每个字段的 schema | `{ path: { type: "string" } }` |
| `required` | 哪些字段必须提供 | `["path"]` |
| `description` | 这个字段的说明（模型会看） | `"文件路径"` |
| `items` | 数组里每个元素的 schema | `{ type: "string" }` |
| `enum` | 只能取这几个值之一 | `["celsius", "fahrenheit"]` |

工具参数的顶层必须是 `type: "object"`。我们在 `types.ts` 里定义了 `JsonSchema` 接口，只包含这些关键字。

## 4. 新的类型

[code/src/ai/types.ts](code/src/ai/types.ts) 增加了这些东西：

```ts
/** 模型请求调用一个工具 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** 工具执行完的结果，发回给模型 */
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
	details?: unknown;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

- `ToolCall` 是助手消息里的一种**内容块**：`AssistantMessage.content` 现在是 `(TextContent | ThinkingContent | ToolCall)[]`。模型可以先说一句话，再调用工具，一次还可以调用好几个。
- `ToolResultMessage` 是一种新的**消息**。`toolCallId` 指回它对应的那次调用——这就是为什么每次调用都要有一个唯一的 `id`。
- `isError`：工具执行失败时为 `true`，`content` 里放错误信息。**失败的结果也要发回给模型**，模型看到错误后往往会换个办法再试。
- `details`：给界面用的额外信息（比如修改文件时的 diff），**不发给模型**。

还有：

```ts
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];       // 新增
}
```

事件也增加了三种，和文字、思考的事件一模一样：

```ts
| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
```

`toolcall_delta` 的 `delta` 是参数 JSON 的一小段文字（比如 `{"path":`），下一节会讲为什么参数是一段段到达的。

### 一条重要的规则：调用和结果必须配对

**每一个 `ToolCall`，后面都必须跟着一个对应的 `ToolResultMessage`。** 如果你把一条包含工具调用的助手消息发给模型，后面却没有对应的工具结果，几乎所有服务商都会直接返回 400 错误。比如 OpenAI 会说 "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"。

这是里程碑 04 那条原则的加强版：**历史必须始终保持合法。** 下一章写 Agent Loop 时，即使工具执行出错、甚至用户中途取消，也必须为每个调用补上一个结果。

### 两道保险：transformMessages

程序总有出意外的时候：执行工具时进程崩溃了、用户在模型输出工具调用的过程中按了取消……为了让发给模型的历史**一定**合法，适配器在翻译消息之前，先用 [code/src/ai/transform.ts](code/src/ai/transform.ts) 里的 `transformMessages` 整理一遍：

1. **出错或被取消的助手消息不发送。** 它们是没完成的回复，里面可能有写了一半的工具调用（参数不完整）。它们仍然保存在历史里，界面可以显示，只是不发给模型。
2. **没有结果的工具调用，补上一个错误结果**："没有结果（这个工具调用没有被执行）"。

```ts
export function transformMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let pending: ToolCall[] = [];      // 上一条助手消息里、还没有找到结果的工具调用
	let answered = new Set<string>();

	const closePending = () => {
		for (const call of pending) {
			if (!answered.has(call.id)) result.push(/* 一个 isError 的 ToolResultMessage */);
		}
		pending = [];
		answered = new Set();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			closePending();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			pending = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			result.push(message);
		} else if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			result.push(message);
		} else {
			closePending();   // 新的用户消息之前，补上上一轮缺失的结果
			result.push(message);
		}
	}
	closePending();
	return result;
}
```

注意区分两个概念：**历史**（程序保存的完整记录，包括出错的回复）和**发给模型的上下文**（整理过的、一定合法的版本）。里程碑 05 我们把被打断的半截回答保留在历史里，这仍然是对的；只是从这一章开始，它不会再被发给模型。pi 的做法完全一样。

## 5. 两种协议里的工具调用

和上一章一样，两种协议的格式完全不同，适配器负责翻译。

### 5.1 请求里的工具定义

```jsonc
// OpenAI
"tools": [{ "type": "function", "function": { "name": "calculate", "description": "……", "parameters": { /* schema */ } } }]

// Anthropic
"tools": [{ "name": "calculate", "description": "……", "input_schema": { /* schema */ } }]
```

### 5.2 模型返回的工具调用（流式）

OpenAI 在 `delta.tool_calls` 里分多个 chunk 发送，用 `index` 区分是第几个调用。第一个片段带着 `id` 和函数名，后面的片段只带参数的一小段：

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_8mn","type":"function","function":{"name":"read","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"package"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".json\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

Anthropic 把工具调用作为一个 `tool_use` 内容块，参数用 `input_json_delta` 分段发送：

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_dar","name":"bash","input":{}}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"comman"}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"d\":\"ls -la\"}"}}
event: content_block_stop
data: {"type":"content_block_stop","index":1}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":24}}
```

两种协议都用一个专门的停止原因表示"我要调用工具，等你的结果"：OpenAI 的 `finish_reason: "tool_calls"`、Anthropic 的 `stop_reason: "tool_use"`，我们统一翻译成 `toolUse`。

### 5.3 历史里的工具调用和结果

```jsonc
// OpenAI：助手消息带 tool_calls（注意参数是 JSON 字符串！），结果是 role: "tool" 的消息
{ "role": "assistant", "content": null,
  "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "read", "arguments": "{\"path\":\"a.txt\"}" } }] }
{ "role": "tool", "tool_call_id": "call_1", "content": "文件内容" }

// Anthropic：助手消息里是 tool_use 块（参数是对象），结果是 user 消息里的 tool_result 块
{ "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": "read", "input": { "path": "a.txt" } }] }
{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "文件内容", "is_error": false }] }
```

两个容易踩的坑：

- OpenAI 要求历史里的参数是 **JSON 字符串**，Anthropic 要求是**对象**。
- Anthropic 要求**一次回复里所有工具调用的结果，放在同一条 user 消息里**。如果模型一次调用了 3 个工具，你要把 3 个 `tool_result` 块放进一条消息，而不是发 3 条消息。（分成多条消息时请求虽然可能被接受，但会让模型逐渐"学会"不再并行调用工具。）

## 6. 参数是一点一点到达的：parsePartialJson

### 6.1 问题

模型要写一个 500 行的文件时，`write` 工具的参数可能有几万个字符，要流式输出好几秒。在这几秒里，我们收到的是一段**还没写完的 JSON**：

```
{"path": "src/main.ts", "content": "import { readFile } from \"node:fs\";\nconst
```

`JSON.parse` 会直接报错。但界面很想在这时候就显示"正在写入 src/main.ts……"，而不是等全部写完才显示。

### 6.2 解决：补全之后再解析

[code/src/ai/json.ts](code/src/ai/json.ts) 的 `parsePartialJson` 做的事情是：从头扫描一遍，记住哪些字符串和括号还没闭合，然后在末尾补上：

```
{"path": "src/main.ts", "content": "import { readFile
                                                     ↓ 补上 "}
{"path": "src/main.ts", "content": "import { readFile"}
```

核心是一个小小的"状态机"：

```ts
function closeJson(text: string): string {
	const closers: string[] = [];
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;          // 上一个字符是 \，这个字符被转义了，跳过
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false; // 字符串结束
			continue;                              // 字符串里的 { } 不算括号
		}
		if (ch === '"') inString = true;
		else if (ch === "{") closers.push("}");
		else if (ch === "[") closers.push("]");
		else if (ch === "}" || ch === "]") closers.pop();
	}
	let result = text;
	if (inString) {
		if (escaped) result = result.slice(0, -1); // 末尾是半个转义符 \，去掉它
		result += '"';
	}
	result = result.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
	return result + closers.reverse().join("");
}
```

三个状态：在不在字符串里（`inString`）、上一个字符是不是反斜杠（`escaped`）、还有哪些括号没闭合（`closers`，一个栈）。字符串里的 `{`、`}` 和被转义的引号 `\"` 都不能算数，这正是需要状态机的原因。

补全之后如果还是解析失败（比如末尾是写了一半的 `tru` 或 `12.`），就去掉最后一个字符再试，最多试 32 次。实在不行返回 `{}`。

还有一个现实中的问题：有的模型会在 JSON 字符串里直接输出一个真正的换行符，而不是 `\n`，这在 JSON 里是不合法的。`escapeRawControlCharacters` 会先修复这种情况。

适配器在每个 `toolcall_delta` 时调用 `parsePartialJson` 更新 `ToolCall.arguments`（半成品），在 `toolcall_end` 时用完整的 JSON 再解析一次（完整的 JSON 一定能正确解析）。

## 7. 改造适配器

### 7.1 OpenAI 适配器

完整代码：[code/src/ai/providers/openai.ts](code/src/ai/providers/openai.ts)。三处改动：

**翻译消息**：助手消息带上 `tool_calls`；工具结果变成 `role: "tool"` 的消息；只有工具调用、没有文字的助手消息也要发送（`content` 为 `null`）。

```ts
case "toolResult": {
	const text = message.content.map((block) => block.text).join("\n");
	result.push({ role: "tool", tool_call_id: message.toolCallId, content: text || "(没有输出)" });
	break;
}
```

（结果为空时填一个占位文字，有些服务商不接受空的 `content`。）

**解析工具调用**：用一个 `Map` 按 OpenAI 给的 `index` 保存每个调用和它的参数文字：

```ts
const toolCalls = new Map<number, { block: ToolCall; json: string }>();

for (const callDelta of delta.tool_calls ?? []) {
	endCurrent();
	const index = callDelta.index ?? 0;
	let entry = toolCalls.get(index);
	if (!entry) {
		entry = { block: { type: "toolCall", id: callDelta.id ?? `call_${index}`, name: "", arguments: {} }, json: "" };
		toolCalls.set(index, entry);
		output.content.push(entry.block);
		stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
	}
	if (callDelta.id) entry.block.id = callDelta.id;
	if (callDelta.function?.name && !entry.block.name) entry.block.name = callDelta.function.name;
	const piece = callDelta.function?.arguments ?? "";
	if (piece) {
		entry.json += piece;
		entry.block.arguments = parsePartialJson(entry.json);
		stream.push({ type: "toolcall_delta", contentIndex: output.content.indexOf(entry.block), delta: piece, partial: output });
	}
}
```

所有工具调用的 `toolcall_end` 在流结束时统一发出，那时参数一定已经完整了。

**停止原因**：`tool_calls` 翻译成 `toolUse`。另外，有些"兼容"的服务商在调用工具时返回的是 `stop`，我们以实际内容为准：只要有工具调用，就算作 `toolUse`。

### 7.2 Anthropic 适配器

完整代码：[code/src/ai/providers/anthropic.ts](code/src/ai/providers/anthropic.ts)。

`content_block_start` 时遇到 `tool_use` 块就新建一个 `ToolCall`，`input_json_delta` 时追加参数文字，`content_block_stop` 时完整解析并发出 `toolcall_end`。结构和文字块完全一样。

翻译工具结果时，要把同一次回复的多个结果合并进一条 user 消息：

```ts
case "toolResult": {
	const block: AnthropicContentBlock = {
		type: "tool_result",
		tool_use_id: message.toolCallId,
		content: message.content.map((item) => item.text).join("\n") || "(没有输出)",
		is_error: message.isError,
	};
	const previous = result.at(-1);
	if (previous?.role === "user" && Array.isArray(previous.content)) {
		previous.content.push(block);   // 上一条已经是装着工具结果的 user 消息，追加进去
	} else {
		result.push({ role: "user", content: [block] });
	}
	break;
}
```

### 7.3 假模型

[code/src/ai/providers/faux.ts](code/src/ai/providers/faux.ts) 的剧本里增加了 `toolCalls`：

```ts
createFauxModel([
	{ text: "我来读取。", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] },
	{ text: "文件里写着……" },
]);
```

它会产生和真实适配器一样的 `toolcall_*` 事件，有工具调用时 `stopReason` 自动是 `toolUse`。它还会记录每次请求带了哪些工具（`requests[i].tools`）。下一章测试 Agent Loop 时，这个能力至关重要。

## 8. 推理模型的特殊要求：当前这一轮的思考要发回

里程碑 06 决定"之前几轮的思考内容不发回"。但工具调用带来了一个例外。

**问题**：推理模型（比如 DeepSeek 的推理模型、Claude）在调用工具之前会先思考。拿到工具结果后，它要接着之前的思路继续推理。如果我们把这次思考丢掉了，模型就"忘了自己刚才在想什么"。所以服务商要求：**在工具循环里，当前这一轮的思考内容必须原样发回。** Anthropic 甚至会直接拒绝缺少思考块的工具循环请求。

但是，**之前几轮**的思考仍然不应该发回：

- DeepSeek 的文档明确要求，新的一轮对话不要带上之前几轮的思考内容；
- Anthropic 的思考块带有签名，只对生成它的那个模型、那段对话有效。里程碑 15 压缩上下文时会改动历史，改动之后再发回旧的思考块，可能会被拒绝。

**解决**：一条简单的规则，放在 [code/src/ai/transform.ts](code/src/ai/transform.ts) 里，两个适配器共用：

```ts
export function canReplayThinking(message: AssistantMessage, index: number, lastUserIndex: number, model: Model): boolean {
	return (
		index > lastUserIndex &&                // 1. 在最后一条用户消息之后：属于当前这一轮
		message.api === model.api &&            // 2. 是同一个模型生成的
		message.provider === model.provider &&
		message.model === model.id
	);
}
```

"当前这一轮"的意思是：用户最后说的那句话之后的所有消息。在一个工具循环里，这些消息依次是 `assistant（思考 + 工具调用）→ toolResult → assistant（思考 + 工具调用）→ toolResult → ……`。

满足条件时，OpenAI 适配器把思考内容放回它原来的字段（`signature` 里记着字段名，比如 `reasoning_content`），Anthropic 适配器把思考块连同签名原样发回。里程碑 06、07 预留的 `signature` 字段终于派上了用场。

## 9. 手动完成一次往返

[code/playground/tool-demo.ts](code/playground/tool-demo.ts) 把这一章的内容串了起来。它分四步：

**1. 定义工具**：`get_current_time` 和 `calculate`（见第 3 节）。

**2. 执行工具的函数**：

```ts
function runTool(call: ToolCall): { text: string; isError: boolean } {
	switch (call.name) {
		case "get_current_time":
			return { text: new Date().toLocaleString("zh-CN"), isError: false };
		case "calculate": {
			const expression = call.arguments.expression;
			if (typeof expression !== "string") return { text: "参数 expression 必须是字符串", isError: true };
			if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
				return { text: `不支持的表达式：${expression}`, isError: true };
			}
			// ……计算……
		}
		default:
			return { text: `没有这个工具：${call.name}`, isError: true };
	}
}
```

注意两件事：

- **参数是模型生成的，不可信。** 模型可能漏掉参数、给错类型，所以要检查 `typeof expression !== "string"`。下一章会用 JSON Schema 自动校验。
- **永远不要直接执行来路不明的代码。** `calculate` 用正则表达式只允许数字、运算符和括号，否则模型（或者通过提示词注入控制了模型的攻击者）可能让你执行任意代码。

**3. 发请求，流式打印**（包括工具调用的参数一点点出现的过程）。

**4. 主流程**：第 1 次请求 → 如果 `stopReason` 是 `toolUse`，执行每个工具调用，把结果作为 `ToolResultMessage` 加入历史 → 第 2 次请求。

```ts
for (const block of first.content) {
	if (block.type !== "toolCall") continue;
	const result = runTool(block);
	messages.push({
		role: "toolResult",
		toolCallId: block.id,
		toolName: block.name,
		content: [{ type: "text", text: result.text }],
		isError: result.isError,
		timestamp: Date.now(),
	});
}
```

### 运行

先启动假模型服务器（它的 rules 模式能听懂"现在几点""计算 …"，并且会调用名为 `get_current_time` 和 `calculate` 的工具）：

```bash
node playground/tool-demo.ts "现在几点 同时 计算 23*47"
```

"同时"会让假模型在一次回复里调用两个工具（见本章开头的输出）。再试试"然后"：

```bash
node playground/tool-demo.ts "现在几点 然后 计算 23*47"
```

```
========== 执行工具 ==========
get_current_time({}) → 2026/10/12 22:07:22

========== 第 2 次请求（带上工具结果） ==========
我来计算 23*47。
[调用 calculate] {"expression":"23*47"}

模型还想继续调用工具！但这个脚本只做一次往返，没法继续了。
```

模型拿到时间之后，又想调用计算工具。但我们的脚本只写了一次往返，没法继续了。真实的任务往往需要很多步：先读这个文件，再读那个文件，然后修改，再运行测试，看到错误再修改……我们需要一个**循环**，让模型想调用多少次就调用多少次。这就是下一章的主题——**Agent Loop**。

用真实模型试试（大多数主流模型都支持工具调用）：

```bash
node --env-file=.env playground/tool-demo.ts --model deepseek/deepseek-chat "现在几点了？顺便算一下 23*47"
```

## 10. 接口约定与测试

| 文件 | 变化 |
| --- | --- |
| `src/ai/types.ts` | 新增 `ToolCall`、`ToolResultMessage`、`JsonSchema`、`Tool`；`Message` 加入 `ToolResultMessage`；`StopReason` 加入 `"toolUse"`；`Context.tools`；三种 `toolcall_*` 事件；`done.reason` 加入 `"toolUse"` |
| `src/ai/json.ts` | `parsePartialJson(text)` |
| `src/ai/transform.ts` | `transformMessages(messages)`、`findLastUserIndex(messages)`、`canReplayThinking(message, index, lastUserIndex, model)` |
| `src/ai/providers/openai.ts`、`anthropic.ts` | `convertMessages(model, context)`（注意多了 `model` 参数）；支持工具 |
| `src/ai/providers/faux.ts` | `FauxReply.toolCalls`；`FauxRequest.tools` |

本章新增的测试：`json.test.ts`、`transform.test.ts`、`openai-tools.test.ts`、`anthropic-tools.test.ts`，以及 `faux.test.ts` 里的工具调用测试。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 400：tool_calls must be followed by tool messages / tool_use ids were found without tool_result blocks | 有工具调用没有对应的结果；或者结果的 id 和调用对不上 |
| 模型根本不调用工具 | 请求里没带 `tools`；工具描述写得太模糊；或者这个模型不支持工具调用 |
| 模型调用了工具，但参数是 `{}` | 参数的 JSON 片段没有拼起来，或者在 `toolcall_end` 时没有用完整的 JSON 解析 |
| OpenAI 返回 400，说 arguments 格式不对 | 历史里的参数要用 `JSON.stringify` 转成字符串 |
| Anthropic 的工具结果分散在多条消息里 | 要把同一次回复的所有结果合并进一条 user 消息 |
| 推理模型在第二次请求时报错，提到 thinking / reasoning_content | 当前这一轮的思考内容没有发回 |

## 12. 练习

1. **加一个工具**：给 `tool-demo.ts` 加一个 `get_weather` 工具（返回假数据即可），参数 `city`（字符串）和 `unit`（`enum: ["celsius", "fahrenheit"]`）。用真实模型问"北京和上海哪里更热？"，观察模型会不会一次调用两次。
2. **让工具出错**：让 `calculate` 总是返回 `isError: true` 和"计算器坏了"。观察真实模型收到错误后怎么回应。
3. **看看完整的请求**：用 `--verbose` 启动假模型服务器，运行 `tool-demo.ts`，找到第 2 次请求里的 `tool_calls` 和 `role: "tool"` 消息。再换成 `--model fake-anthropic/fake-model`，对比 Anthropic 格式的请求。
4. **描述的威力**：把 `calculate` 的描述改成 `"一个工具"`，名字改成 `"foo"`。用真实模型问一道乘法题，模型还会调用它吗？
5. **parsePartialJson 的边界**：给 `parsePartialJson` 写更多测试：字符串里有 `{` 和 `}`、Unicode 转义 `你`、数字写到一半 `{"n": -1.`。

## 13. 自测问题

1. 工具调用时，是谁在执行工具？模型返回的到底是什么？
2. `description` 为什么重要？
3. 工具执行失败了，为什么还要把结果发回给模型？
4. 如果助手消息里有一个工具调用，但后面没有对应的工具结果，会发生什么？
5. 为什么流式输出时要解析"不完整的 JSON"？
6. 推理模型在工具循环中，为什么要发回当前这一轮的思考内容？为什么不发回之前几轮的？
7. Anthropic 的多个工具结果为什么要放在同一条消息里？

<details>
<summary>参考答案</summary>

1. 我们的程序执行。模型只返回一段结构化数据，说明想调用哪个工具、参数是什么。
2. 模型完全靠工具的名字和描述决定要不要用、怎么用。描述不清，模型就不会用或者用错。
3. 模型看到错误信息后可以调整做法（换参数、换工具、或者告诉用户）。如果不发回，历史就不合法（调用缺少结果），请求会被拒绝。
4. 几乎所有服务商都会返回 400 错误。
5. 长参数（比如写文件的内容）要流式输出很久，提前解析出半成品，界面就能实时显示进度，比如正在写哪个文件。
6. 模型拿到工具结果后要接着刚才的思路推理，服务商要求发回当前这一轮的思考；之前几轮的思考对模型没有用，服务商要求或建议不发回，而且改动过的历史会让旧的思考块失效。
7. 一次回复里的多个工具调用是"并行"的，它们的结果属于同一轮。Anthropic 要求放在同一条消息里，否则会让模型逐渐不再并行调用工具。

</details>

## 14. 对照 pi 源码

- **类型**：[packages/ai/src/types.ts](../../packages/ai/src/types.ts) 里的 `ToolCall`、`ToolResultMessage`、`Tool`。pi 的 `Tool.parameters` 是用 [TypeBox](https://github.com/sinclairzx81/typebox) 写的 schema：`Type.Object({ path: Type.String() })`。TypeBox 生成的就是标准的 JSON Schema，同时还能推导出 TypeScript 类型。我们手写 JSON Schema，少一个依赖，概念完全一样。
- **OpenAI 适配器里的工具调用**：在 [openai-completions.ts](../../packages/ai/src/api/openai-completions.ts) 里搜索 `toolCallBlocksByIndex`，你会看到 pi 同样按 `index`（以及 `id`）保存每个调用，用 `partialArgs` 攒参数文字，每次用 `parseStreamingJson` 更新 `arguments`。搜索 `finishBlock`，看它在结束时怎么做最终解析。
- **流式 JSON 解析**：[packages/ai/src/utils/json-parse.ts](../../packages/ai/src/utils/json-parse.ts) 的 `parseStreamingJson`。pi 先尝试完整解析（并修复裸控制字符和非法转义），失败后交给 `partial-json` 这个库。我们自己写了一个简化版。
- **整理历史**：[transform-messages.ts](../../packages/ai/src/api/transform-messages.ts)。文件末尾的 "Second pass" 就是我们的两道保险：跳过 `stopReason` 为 `error`/`aborted` 的助手消息（注释说："These are incomplete turns that shouldn't be replayed"），为孤立的工具调用插入 "No result provided" 的错误结果。前半部分处理跨模型的消息：pi 的规则是"同一个模型的思考块保留"，并为压缩等改动历史的场景做了专门处理；我们的规则更保守："只发回当前这一轮、同一个模型的"。
- **被截断的工具调用**：[packages/agent/src/agent-loop.ts](../../packages/agent/src/agent-loop.ts) 里有一段注释："A 'length' stop means the output was cut off by the token limit, so every tool call in the message may carry truncated arguments. Fail them all instead of executing potentially borked calls." 输出被截断时，工具参数可能不完整（`parsePartialJson` 会"尽力"解析出一个看起来合法的半成品！），执行它们可能很危险。下一章我们会处理这个问题。

## 15. 闭卷挑战

不看资料：

1. 写出 `parsePartialJson`（包括 `closeJson` 状态机），让 `test/json.test.ts` 通过；
2. 写出 `tool-demo.ts` 的主流程：两次请求、中间执行工具、构造 `ToolResultMessage`。

60 分钟内完成即可进入下一章——整门课最核心的一章。

---

上一步：[里程碑 07：第二个服务商与模型注册表](../07-providers/README.md) · 下一步：[里程碑 09：Agent Loop](../09-agent-loop/README.md)
