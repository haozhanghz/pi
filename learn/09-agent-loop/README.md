# 里程碑 09：Agent Loop

> 目标：写出整门课最核心的代码——agent loop（智能体循环）。模型想调用多少次工具就调用多少次，直到它认为任务完成了。
>
> 完成后你将拥有：`src/agent/` 目录（工具的类型、参数校验、循环本身），以及你的第一个真正的 agent：`playground/agent-demo.ts`。

```
$ node playground/agent-demo.ts
agent 已就绪。模型：fake/fake-model，工具：get_current_time、calculate、read

你> 读取 package.json 然后 计算 23*47
我来读取 package.json。
> read {"path":"package.json"}
  {
  	"name": "my-pi",
  	"version": "0.0.9",
  	"private": true,
  …（共 15 行）
我来计算 23*47。
> calculate {"expression":"23*47"}
  1081
完成！一共执行了 2 个工具调用，结果如下：……
（请求模型 3 次，调用工具 2 次，共 496 tokens）
```

## 你将学到

- agent 的本质：一个 `while` 循环
- "轮"（turn）和事件：让界面实时知道循环进行到了哪一步
- 错误处理的原则：工具出什么错都不能让循环崩溃，错误要告诉模型
- 用 JSON Schema 校验模型给的参数，并自动修正小问题
- 用户中途取消时，怎么保证历史仍然合法

---

## 1. 问题：一次往返不够

上一章结尾，`tool-demo.ts` 遇到了这种情况：

```
模型还想继续调用工具！但这个脚本只做一次往返，没法继续了。
```

真实的编程任务需要很多步。比如你说"测试挂了，帮我修一下"，一个 coding agent 实际会这样做：

```
你：测试挂了，帮我修一下
模型：我先运行测试看看。          → bash("npm test")        → 结果：1 个测试失败，期望 3，实际 2
模型：我看看这个函数。            → read("src/math.ts")      → 结果：文件内容
模型：第 12 行的循环少算了一次。  → edit("src/math.ts", …)   → 结果：修改成功
模型：再运行一次测试确认。        → bash("npm test")        → 结果：全部通过
模型：修好了。原因是第 12 行……（不再调用工具）
```

每一步做什么，取决于上一步的结果。事先谁也不知道需要几步。

## 2. 解决：一个循环

```ts
while (true) {
	const reply = await callModel(messages, tools);   // ① 问模型
	messages.push(reply);
	const calls = reply.content.filter((block) => block.type === "toolCall");
	if (calls.length === 0) break;                    // ② 不再调用工具：任务完成
	for (const call of calls) {
		const result = await runTool(call);            // ③ 执行工具
		messages.push(result);                         // ④ 结果加入对话，回到 ①
	}
}
```

**这就是 agent 的全部秘密。** Claude Code、pi、各种 IDE 里的 agent 模式，核心都是这个循环。剩下的一切——好用的工具、好的系统提示词、会话保存、上下文压缩、漂亮的界面——都是围绕它搭建的。

注意一个本质的区别：**什么时候停，由模型决定。** 我们的代码不知道任务需要几步，它只是一直循环，直到模型不再调用工具。这就是 agent 和普通"工作流"的区别：工作流的步骤是程序员事先写死的，agent 的步骤是模型在运行时决定的。

这个 10 行的循环离真正可用还差几件事：

| 问题 | 本章的解决办法 |
| --- | --- |
| 用户看不到进度 | 循环的每一步都发出**事件**，界面根据事件显示 |
| 工具抛出异常，整个程序崩溃 | 捕获所有错误，把错误信息作为工具结果发给模型 |
| 模型给的参数不对（漏了、类型错了） | 用 JSON Schema **校验**：小问题自动修正，大问题告诉模型 |
| 模型调用了不存在的工具 | 返回错误，告诉它有哪些工具可用 |
| 用户想中途停下来 | 支持 `AbortSignal`，并且保证历史合法 |
| 回复被截断，工具参数不完整 | 不执行，让模型重新调用 |

## 3. agent 层的类型

新建 `src/agent/` 目录。ai 层负责"和模型说话"，agent 层负责"循环和执行工具"：

```
src/agent/   循环、执行工具            ← 本章
   │ 只依赖 ↓
src/ai/      和模型说话（适配器）      ← 里程碑 06~08
```

ai 层完全不知道 agent 层的存在。这种单向依赖让每一层都可以单独理解、单独测试。pi 也是这样分成 `pi-ai` 和 `pi-agent-core` 两个包的。

### 3.1 AgentTool：定义 + 执行

[code/src/agent/types.ts](code/src/agent/types.ts)：

```ts
export interface AgentToolResult {
	content: TextContent[];   // 发给模型看的内容
	details?: unknown;        // 给界面用的额外信息，不发给模型
	isError?: boolean;        // 不抛异常也能报告失败
}

export interface AgentTool<TArgs = Record<string, unknown>> extends Tool {
	label?: string;           // 给人看的名字（界面上显示）
	execute(toolCallId: string, args: TArgs, signal?: AbortSignal, onUpdate?: AgentToolUpdate): Promise<AgentToolResult>;
}
```

`Tool` 是给模型看的"说明书"（名字、描述、参数格式），`AgentTool` 在它的基础上加了真正干活的 `execute`。它的四个参数：

- `toolCallId`：这次调用的 id。大多数工具用不到。
- `args`：参数。**循环会先校验参数，再交给 `execute`**（第 8 节），所以工具里可以放心使用。
- `signal`：用户取消时，工具应该尽快停下来。比如里程碑 12 的 bash 工具会杀掉正在运行的命令。
- `onUpdate`：报告进度。比如一个运行很久的命令，每输出一行就报告一次，界面就能实时显示。

`TArgs` 是一个**泛型参数**（里程碑 01 学过），让工具代码拿到有类型的参数：

```ts
const read: AgentTool<{ path: string }> = {
	name: "read",
	description: "读取一个文本文件的内容。路径相对于当前目录。",
	parameters: {
		type: "object",
		properties: { path: { type: "string", description: "文件路径" } },
		required: ["path"],
	},
	async execute(_id, { path }) {          // path 的类型是 string
		return { content: [{ type: "text", text: await readFile(path, "utf-8") }] };
	},
};
```

`{ path: string }` 和 `parameters` 描述的是同一件事：一个给 TypeScript 看，一个给模型和校验器看。**两者保持一致是你的责任**，TypeScript 不会帮你检查。（pi 用 TypeBox 库从同一份定义里同时得到两者，所以不会不一致。）

工具报告失败有两种方式：

```ts
throw new Error("文件不存在");                                          // 方式一：抛异常
return { content: [{ type: "text", text: "退出码 1" }], isError: true };  // 方式二：返回 isError
```

两种方式效果一样：模型收到一个 `isError: true` 的工具结果。方式二适合"失败了，但有输出要给模型看"的情况，比如命令执行失败但打印了错误信息。

### 3.2 上下文和配置

```ts
export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools: AgentTool[];
}

export interface AgentLoopConfig {
	model: Model;
	apiKey?: string;
	maxTokens?: number;
	temperature?: number;
	streamFn?: StreamFunction;   // 默认是 ai 层的 stream
}
```

`streamFn` 让调用者可以换掉"调用模型"的方式，比如里程碑 20 会包一层自动重试。不传就用 ai 层的 `stream`。

## 4. 轮（turn）和事件

### 4.1 什么是"一轮"

**一轮 = 调用一次模型 + 执行它要求的所有工具。** 上面"修测试"的例子一共 5 轮：前 4 轮模型都调用了工具，第 5 轮没有，循环结束。用户说一句话，可能产生一轮，也可能产生几十轮。

### 4.2 事件

循环本身**不打印任何东西**。它在每个关键时刻发出一个事件，谁调用它，谁决定怎么显示：

```ts
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage; event: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };
```

"读取 package.json 然后 计算 23*47" 产生的事件（省略了 `message_update`）：

```
agent_start
turn_start                               ← 第 1 轮
  message_start / message_end            用户消息
  message_start                          模型开始回复
    （message_update × N）               文字和工具调用一点点到达
  message_end                            回复完成：一句话 + 调用 read
  tool_execution_start   read
  tool_execution_end     read
  message_start / message_end            工具结果消息
turn_end
turn_start                               ← 第 2 轮
  message_start … message_end            回复：调用 calculate
  tool_execution_start   calculate
  tool_execution_end     calculate
  message_start / message_end            工具结果消息
turn_end
turn_start                               ← 第 3 轮
  message_start … message_end            最终回答，没有工具调用
turn_end
agent_end
```

为什么用事件，而不是直接 `console.log`？因为同一个循环要给很多"界面"用：

- 本章的 `agent-demo.ts`：打印到终端；
- 里程碑 13 的 print 模式：只输出最终回答；
- 里程碑 14：每条消息完成时（`message_end`）保存到会话文件；
- 里程碑 19 的全屏界面：渲染成组件；
- 测试：把事件收集到数组里，检查顺序对不对。

循环只管"发生了什么"，不管"怎么显示"。这叫**关注点分离**。

### 4.3 emit 可以是 async 的

```ts
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
```

循环每次都 `await emit(...)`。如果接收事件的函数是 async 的（比如要把消息写进文件），循环会等它处理完再继续。这保证了**顺序**：消息一定先保存好，再进行下一步。

## 5. runAgentLoop 逐行解读

完整代码：[code/src/agent/loop.ts](code/src/agent/loop.ts)。先看签名：

```ts
export async function runAgentLoop(
	prompts: Message[],       // 这次新加入的消息（通常是一条用户消息）
	context: AgentContext,    // 之前的对话、系统提示词、工具
	config: AgentLoopConfig,  // 用哪个模型
	emit: AgentEventSink,     // 接收事件
	signal?: AbortSignal,     // 用来中途取消
): Promise<Message[]>         // 这次运行新产生的所有消息
```

主体：

```ts
const messages: Message[] = [...context.messages]; // 工作副本
const newMessages: Message[] = [];
const append = (message: Message) => {
	messages.push(message);
	newMessages.push(message);
};

await emit({ type: "agent_start" });
await emit({ type: "turn_start" });
for (const prompt of prompts) {
	append(prompt);
	await emit({ type: "message_start", message: prompt });
	await emit({ type: "message_end", message: prompt });
}

while (true) {
	// ① 调用模型（流式），得到一条完整的回复
	const assistant = await streamAssistantResponse(messages, context, config, emit, signal);
	append(assistant);

	// ② 出错或被取消：这一轮结束，整个运行也结束
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		await emit({ type: "turn_end", message: assistant, toolResults: [] });
		break;
	}

	// ③ 执行模型要求调用的工具，每个调用都要产生一个结果
	const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
	const toolResults: ToolResultMessage[] = [];
	for (const call of toolCalls) {
		const result = await executeToolCall(call, assistant, context.tools, emit, signal);
		append(result);
		toolResults.push(result);
	}
	await emit({ type: "turn_end", message: assistant, toolResults });

	// ④ 没有工具调用：模型已经给出了最终回答
	if (toolCalls.length === 0) break;
	// ⑤ 工具执行期间被取消了：不再调用模型
	if (signal?.aborted) break;
	// ⑥ 带着工具结果，开始新的一轮
	await emit({ type: "turn_start" });
}

await emit({ type: "agent_end", messages: newMessages });
return newMessages;
```

和第 2 节的 10 行版本对比：骨架完全一样，只是多了事件和几个停止条件。下面看几个值得注意的地方。

### 5.1 工作副本：不修改调用者的数组

`[...context.messages]` 复制了一份历史，循环只往副本里加消息。新消息另外记在 `newMessages` 里返回，由调用者自己追加：

```ts
const newMessages = await runAgentLoop([userMessage], { messages: history, tools }, config, render);
history.push(...newMessages);
```

为什么不直接往 `context.messages` 里加？"悄悄修改传进来的参数"是很常见的 bug 来源：调用者以为数组没变，其实已经变了。让函数返回结果、由调用者决定怎么用，代码更容易理解，也更容易测试（`agent-loop.test.ts` 的最后一个测试检查的就是这一点）。下一章的 `Agent` 类会负责保存历史。

### 5.2 三个停止条件

| 条件 | 为什么停 |
| --- | --- |
| ② 回复出错（`error`）或被取消（`aborted`） | 出错时不在这里自动重试（里程碑 20 会做），把决定权交给用户；被取消说明用户想停 |
| ④ 回复里没有工具调用 | 模型认为任务完成了，这条回复就是给用户的答案 |
| ⑤ 执行工具时被取消 | 用户想停。所有工具结果都已经加进历史，下次用户说话时历史是合法的 |

注意 ② 的情况下，出错的回复仍然被 `append` 了：它会留在历史里，界面可以显示错误。上一章的 `transformMessages` 保证它不会被发给模型。

### 5.3 会不会无限循环？

会。如果模型一直调用工具，循环就一直转下去，一直花钱。pi 默认没有轮数上限：用户随时可以按 Esc 停下来，而且复杂的任务调用上百次工具是正常的。练习 1 让你加一个可选的上限。

## 6. streamAssistantResponse：转发模型的流式事件

```ts
async function streamAssistantResponse(messages, context, config, emit, signal): Promise<AssistantMessage> {
	const streamFn = config.streamFn ?? stream;
	const response = streamFn(
		config.model,
		{ systemPrompt: context.systemPrompt, messages, tools: context.tools },
		{ apiKey: config.apiKey, signal, maxTokens: config.maxTokens, temperature: config.temperature },
	);

	let started = false;
	for await (const event of response) {
		if (event.type === "start") {
			started = true;
			await emit({ type: "message_start", message: event.partial });
		} else if (event.type !== "done" && event.type !== "error") {
			await emit({ type: "message_update", message: event.partial, event });
		}
	}
	const message = await response.result();
	// 请求在开始之前就失败了（比如 key 错误）：没有收到 start，这里补一个
	if (!started) await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}
```

它把 ai 层的事件翻译成 agent 层的事件：`start` → `message_start`；文字、思考、工具调用的各种增量 → `message_update`（原始事件放在 `event` 字段里，界面需要时可以看）；最后是 `message_end`。

`context.tools` 的类型是 `AgentTool[]`，可以直接传给 ai 层：`AgentTool` 继承了 `Tool`，适配器只读取 `name`、`description`、`parameters` 三个字段，`execute` 函数不会被发出去。

为什么要"补一个 message_start"？适配器收到 HTTP 响应之后才发 `start` 事件。如果 API key 错了，请求直接失败，只有一个 `error` 事件。为了让界面总能看到成对的 `message_start` / `message_end`，这里补上。**事件成对出现**是一个重要的约定，界面代码依赖它。

## 7. executeToolCall：从不失败的工具执行

这是本章第二重要的函数。它有一条铁律：**不管发生什么，都返回一个工具结果，从不抛出异常。** 原因上一章说过：每个工具调用都必须有对应的结果，否则历史不合法，下一次请求会被拒绝。

它依次检查这些情况：

```
回复被截断了（stopReason: "length"）？ → 错误："参数可能不完整，请重新调用"
用户已经取消了？                        → 错误："操作被取消，这个工具没有执行"
没有这个名字的工具？                    → 错误："没有名为 X 的工具。可用的工具有：……"
参数校验失败？                          → 错误：哪些参数不对 + 收到了什么
执行时抛出了异常？                      → 错误：异常信息
都没问题                                → 工具的返回值
```

前五种情况都会产生一个 `isError: true` 的工具结果发给模型。**模型看到错误后，通常能自己纠正**：参数错了就改参数，工具名写错了就换成正确的，文件不存在就先列一下目录。这是 agent 的一个重要特性：**错误是给模型的反馈，而不是程序的终点。**

### 7.1 被截断的回复

上一章最后提到：回复达到 `maxTokens` 上限被截断时（`stopReason: "length"`），最后一个工具调用的参数可能只写了一半。`parsePartialJson` 会"尽力"把它解析成一个看起来合法的对象——比如本来要写入 500 行的文件，结果只有前 200 行。执行它很危险。所以一律不执行，让模型用完整的参数重新调用。

### 7.2 取消时也要有结果

```ts
} else if (signal?.aborted) {
	result = textResult("操作被取消，这个工具没有执行。");
	isError = true;
}
```

假设模型一次调用了 3 个工具，执行第 1 个时用户按了 Ctrl+C。第 2、3 个不再执行，但仍然各自得到一个"被取消"的结果。这样历史里每个调用都有结果，用户接着说话时不会出错。

### 7.3 进度报告的顺序

```ts
const updates: Promise<void>[] = [];
let acceptingUpdates = true;
try {
	const args = validateToolArguments(tool, call.arguments);
	result = await tool.execute(call.id, args, signal, (partialResult) => {
		if (!acceptingUpdates) return; // 工具已经结束了，晚到的进度报告忽略掉
		updates.push(
			Promise.resolve(emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, partialResult })),
		);
	});
	isError = result.isError === true;
} catch (error) {
	// 工具抛出异常（或者参数校验失败）：把错误信息作为结果发回给模型
	result = textResult(error instanceof Error ? error.message : String(error));
	isError = true;
}
acceptingUpdates = false;
await Promise.all(updates);
```

工具调用 `onUpdate` 时，`emit` 可能是 async 的，还没处理完。我们把这些 Promise 收集起来，工具结束后用 `await Promise.all(updates)` 等它们全部处理完，再发 `tool_execution_end`。这保证界面一定先看到所有进度，再看到结束。

还有一个边界情况：有的工具结束之后还会调用 `onUpdate`（比如命令的最后一点输出比进程退出晚到了一点）。`acceptingUpdates` 标志让这些晚到的报告被忽略，不会出现"结束之后又有进度"的怪事。

`Promise.resolve(emit(...))` 是什么意思？`emit` 可能返回 `void`，也可能返回 `Promise<void>`。`Promise.resolve` 把两种情况统一成 Promise，方便交给 `Promise.all`。

注意校验参数的 `validateToolArguments` 也在 `try` 里面：校验失败时它抛出异常，正好被 `catch` 接住，变成发给模型的错误信息。

## 8. 校验参数：validate.ts

### 8.1 问题

模型生成的参数不可信。真实世界中常见的问题：

```jsonc
{ "path": "a.txt", "limit": "20" }     // limit 应该是数字，模型写成了字符串
{ "path": "a.txt", "offset": null }    // 可选参数，模型给了 null，而不是不写
{ "file": "a.txt" }                    // 参数名写错了，必填的 path 没有
{ "path": 123 }                        // 类型完全不对
```

如果不检查，`read` 工具会拿着 `path: undefined` 去读文件，报一个莫名其妙的错误；更糟的情况下，会用错误的参数做了不该做的事。

### 8.2 解决：先修正，再校验

[code/src/agent/validate.ts](code/src/agent/validate.ts) 分两步。

**第一步 `coerce`：自动修正常见的小问题。**

- 需要数字，给的是数字字符串 `"20"` → `20`
- 需要布尔值，给的是 `"true"` / `"false"` → `true` / `false`
- 可选参数给了 `null` → 当作没给

这些情况下模型的意图很明确，没必要让它重试一次（重试要花时间和钱）。

**第二步 `validateValue`：按 schema 递归检查，收集所有问题。**

```ts
export function validateValue(schema: JsonSchema, value: unknown, path: string): string[] {
	const errors: string[] = [];
	// …（enum 的检查省略）
	switch (schema.type) {
		case "object": {
			if (!isPlainObject(value)) {
				errors.push(`${path}：必须是对象，实际是 ${describe(value)}`);
				break;
			}
			for (const key of schema.required ?? []) {
				if (value[key] === undefined) errors.push(`${path}.${key}：缺少必填参数`);
			}
			for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
				if (value[key] !== undefined) errors.push(...validateValue(propertySchema, value[key], `${path}.${key}`));
			}
			break;
		}
		case "string":
			if (typeof value !== "string") errors.push(`${path}：必须是字符串，实际是 ${describe(value)}`);
			break;
		// number、integer、boolean、array……
	}
	return errors;
}
```

这是一个**递归**函数：对象的每个字段、数组的每个元素，都交给同一个函数检查。`path` 参数记录当前检查到了哪里（比如 `参数.edits[0].newText`），这样错误信息能精确指出问题的位置。

**校验失败时，错误信息是写给模型看的：**

```
工具 edit 的参数不正确：
  - 参数.edits[0].newText：缺少必填参数

收到的参数：
{
  "path": "a.txt",
  "edits": [
    {
      "oldText": "x"
    }
  ]
}
```

说清楚哪里错了、它实际发来的是什么，模型就能改正。

我们只实现了 JSON Schema 中最常用的部分（`type`、`properties`、`required`、`items`、`enum`、`additionalProperties: false`），对工具参数来说足够了。

## 9. 运行你的第一个 agent

[code/playground/agent-demo.ts](code/playground/agent-demo.ts) 有三部分：三个工具（`get_current_time`、`calculate`、`read`），一个把事件显示到终端的 `render` 函数，和一个读取用户输入的主循环。

`render` 只关心四种事件：

```ts
function render(event: AgentEvent): void {
	switch (event.type) {
		case "message_update":
			if (event.event.type === "text_delta") process.stdout.write(event.event.delta);
			else if (event.event.type === "thinking_delta") process.stdout.write(dim(event.event.delta));
			break;
		case "tool_execution_start":
			process.stdout.write(`\n${cyan(`> ${event.toolName}`)} ${dim(JSON.stringify(event.args))}\n`);
			break;
		case "tool_execution_end":
			// 缩进显示结果的前 4 行，出错时用红色
			break;
		case "message_end":
			// 回复出错时，用红色显示错误信息
			break;
	}
}
```

主循环：

```ts
for await (const rawLine of rl) {
	// ……
	current = new AbortController();
	const newMessages = await runAgentLoop(
		[{ role: "user", content: line, timestamp: Date.now() }],
		{ systemPrompt, messages: history, tools },
		{ model, apiKey },
		render,
		current.signal,
	);
	current = undefined;
	history.push(...newMessages);
	// ……统计请求次数、工具调用次数和 token 数
}
```

运行时按 Ctrl+C 会调用 `current.abort()` 取消当前的运行；空闲时按 Ctrl+C 退出。

### 运行

先启动假模型服务器，然后：

```bash
node playground/agent-demo.ts
```

试试这些输入：

| 输入 | 观察 |
| --- | --- |
| `读取 package.json 然后 计算 23*47` | 3 次请求、2 次工具调用：模型每次只调用一个工具，看到结果后再决定下一步 |
| `现在几点 同时 计算 23*47` | 2 次请求：一次回复里调用了两个工具 |
| `读取 不存在.txt` | 工具出错（红色显示），错误作为结果发给了模型，模型据此回答 |
| `运行 ls` | 假模型想用 `bash` 工具，但请求里没有这个工具（里程碑 12 才有），它只好直接回答 |

再换成 Anthropic 格式试试：`node playground/agent-demo.ts --model fake-anthropic/fake-model`。循环的代码一行都不用改——这就是里程碑 06 统一类型的回报。

用真实模型：

```bash
node --env-file=.env playground/agent-demo.ts --model deepseek/deepseek-chat
```

试试"读一下 src/agent/loop.ts，用三句话解释它做了什么"。看着你写的 agent 读你写的 agent 的源代码，是一种很奇妙的体验。

## 10. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/agent/types.ts` | `AgentToolResult`、`AgentToolUpdate`、`AgentTool<TArgs>`、`AgentContext`、`StreamFunction`、`AgentLoopConfig`、`AgentEvent`、`AgentEventSink` |
| `src/agent/validate.ts` | `validateValue(schema, value, path)`、`validateToolArguments(tool, args)` |
| `src/agent/loop.ts` | `runAgentLoop(prompts, context, config, emit, signal?)` |
| `src/agent/index.ts` | 导出以上所有内容 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `agent-loop.test.ts`（13 个测试）和 `validate.test.ts`（5 个测试），全部使用假模型，不需要网络。

`agent-loop.test.ts` 值得仔细读一读：它就是本章的"规格说明书"，每个测试的名字都是一条规则。例如：

```ts
test("工具执行期间取消：剩下的工具调用也有结果，不再请求模型", async () => {
	const controller = new AbortController();
	const slow: AgentTool = {
		name: "slow",
		description: "很慢",
		parameters: { type: "object", properties: {} },
		async execute() {
			controller.abort(); // 模拟用户在工具执行时按下了取消
			return { content: [{ type: "text", text: "做完了" }] };
		},
	};
	const faux = createFauxModel([
		{ toolCalls: [{ name: "slow", arguments: {} }, { name: "slow", arguments: {} }] },
		{ text: "不会走到这里" },
	]);
	const result = await runAgentLoop(
		[user("x")], { messages: [], tools: [slow] }, { model: faux.model }, () => {}, controller.signal,
	);
	const results = toolResults(result);
	assert.equal(results.length, 2, "每个工具调用都必须有结果");
	assert.equal(results[1].isError, true);
	assert.match(results[1].content[0].text, /取消/);
	assert.equal(faux.requests.length, 1);
});
```

用假模型写一个剧本：第一次回复调用两个工具，第一个工具执行时触发取消。然后检查：两个调用都有结果，第二个是"被取消"的错误，而且没有再请求模型。不需要网络，不需要真的按 Ctrl+C，几毫秒就跑完了。这就是里程碑 07 做假模型的意义。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 模型调用工具之后，循环就停了 | 停止条件写错了：应该在"回复里没有工具调用"时停 |
| 第二次请求返回 400：tool_calls must be followed by tool messages | 某个工具调用没有产生结果。比如工具抛出异常时你让异常传了出去，或者取消时直接跳过了剩下的调用 |
| 工具抛出异常，整个程序崩溃 | `execute` 没有放在 `try/catch` 里 |
| 一直调用同一个工具，停不下来 | 工具总是返回同样的错误，模型反复重试。检查工具结果有没有说清楚问题出在哪里 |
| 界面先显示"工具结束"，后显示"进度" | 没有等进度事件处理完，就发出了 `tool_execution_end` |
| 第二次提问时，模型不记得第一次的对话 | 忘了 `history.push(...newMessages)` |
| `AgentTool<{ path: string }>` 放不进 `AgentTool[]` 数组，类型报错 | 在 `types.ts` 里把 `execute` 声明成了属性形式 `execute: (…) => Promise<…>`。改成方法形式 `execute(…): Promise<…>` 就可以了：TypeScript 对方法参数的检查比较宽松 |

## 12. 练习

1. **轮数上限**：给 `AgentLoopConfig` 加一个可选的 `maxTurns`，达到上限时不再请求模型，结束运行。写一个测试：假模型的剧本一直调用工具，`maxTurns: 3` 时只请求 3 次。想一想：停下来时最后一条消息是工具结果，历史合法吗？
2. **工具计时**：给 `tool_execution_end` 事件加一个 `durationMs` 字段（工具执行了多少毫秒），在 `agent-demo.ts` 里显示出来。（pi 就有这个字段。）
3. **ls 工具**：给 `agent-demo.ts` 加一个 `ls` 工具（参数 `path` 可选，默认 `.`），用 `readdir` 列出目录内容。用真实模型问"这个目录里有哪些 TypeScript 文件？各自是做什么的？"，观察它怎样先 `ls` 再逐个 `read`。
4. **错误是反馈**：用真实模型说"读一下 packge.json"（故意拼错）。工具返回错误之后，模型做了什么？加上练习 3 的 `ls` 工具再试一次。
5. **在模型回复时取消**：写一个测试：假模型的回复是 `{ text: "一段比较长的回答", delayMs: 50 }`（每输出一小段文字等 50 毫秒），20 毫秒后调用 `controller.abort()`。检查：最后一条消息的 `stopReason` 是 `aborted`，只请求了一次，事件仍然以 `agent_end` 结尾。
6. **思考题：并行执行**。现在多个工具调用是一个接一个执行的。如果模型同时调用了 3 个 `read`，能不能同时执行？如果同时调用的是 `edit` 和 `bash`（改文件、跑测试）呢？结果的顺序重要吗？（下一章会实现并行执行。）

<details>
<summary>练习 1 提示</summary>

在循环开头数一下已经请求了几次。停下来时，最后一条是工具结果，下次用户说话时，用户消息直接接在工具结果后面。每个工具调用都有结果，所以历史是合法的——和"执行工具时被取消"的情况一样。

</details>

## 13. 自测问题

1. 用一句话描述 agent loop。
2. 循环什么时候停？由谁决定？
3. 什么是"一轮"？用户说一句话会有几轮？
4. 循环为什么不直接打印输出，而是发出事件？
5. `executeToolCall` 在哪五种情况下返回错误结果？为什么它从不抛出异常？
6. 回复被截断（`length`）时，为什么不执行其中的工具调用？
7. 为什么要把 `"20"` 自动修正成 `20`，而不是报错让模型重试？
8. `runAgentLoop` 为什么不修改 `context.messages`？

<details>
<summary>参考答案</summary>

1. 调用模型；如果它要求调用工具，就执行工具、把结果加入对话、再调用模型，直到它不再调用工具。
2. 回复里没有工具调用时停（另外，出错或被取消时也停）。由模型决定：程序事先不知道任务需要几步。
3. 调用一次模型，加上执行它要求的所有工具。一次提问可能只有一轮（直接回答），也可能有几十轮。
4. 同一个循环要给不同的界面用（终端、全屏界面、保存会话、测试）。循环只负责"发生了什么"，界面决定"怎么显示"。
5. 回复被截断、已经取消、工具不存在、参数校验失败、执行时抛出异常。因为每个工具调用都必须有结果，否则历史不合法；而且错误信息能帮助模型纠正自己。
6. 被截断时参数可能不完整，而 `parsePartialJson` 可能把它解析成一个看起来合法的半成品，执行它可能造成破坏（比如只写入了半个文件）。
7. 模型的意图很明确，自动修正可以省掉一次重试的时间和费用。
8. 悄悄修改调用者传入的参数，容易造成意料之外的 bug。返回新消息、让调用者决定怎么保存，更清晰，也更容易测试。

</details>

## 14. 对照 pi 源码

pi 的循环在 [packages/agent/src/agent-loop.ts](../../packages/agent/src/agent-loop.ts)，大约 950 行。不要被长度吓到：骨架和我们的一模一样，多出来的大多是后面几章会加的功能。

- **`runAgentLoop`**：签名几乎和我们一样（`prompts, context, config, emit, signal`），同样复制一份 `messages`，同样先发出 `agent_start`、`turn_start` 和每条 prompt 的 `message_start` / `message_end`。
- **`runLoop`**：真正的循环。你会看到**两层** `while`：内层就是我们的循环（"还有工具调用就继续"）；外层处理 **follow-up 消息**——agent 本来要停了，但用户在它工作时排队了一条新消息。内层还会检查 **steering 消息**（用户在 agent 工作时插话）。下一章我们会实现这两种消息队列。`prepareNextTurn`、`prepareRequest`、`finishTurn` 是给上层（比如上下文压缩）在两轮之间插手的"钩子"。
- **`streamAssistantResponse`**：和我们的一样，把 `start` 翻译成 `message_start`，各种增量翻译成 `message_update`，没收到 `start` 时补一个 `message_start`。它还多了 `transformContext`（发送前改写上下文）、`convertToLlm`（把自定义的消息类型转换成模型能懂的消息）、`getApiKey`（每次请求前重新获取 key，因为有的 key 会过期）。
- **`failToolCallsFromTruncatedMessage`**：被截断时不执行工具调用。读读它上面的注释，说的就是第 7.1 节的道理。
- **`prepareToolCall`**：找工具 → `validateToolArguments` → `beforeToolCall` 钩子（里程碑 12 会用它实现"执行危险命令前先问用户"）→ 检查是否已取消。对应我们 `executeToolCall` 的前半部分。
- **`executePreparedToolCall`**：注意 `updateEvents` 和 `acceptingUpdates` 这两个变量，和第 7.3 节的写法一模一样。
- **取消的处理有一点不同**：pi 的 `executeToolCallsSequential` 在取消后直接 `break`，剩下的调用暂时没有结果，由上一章讲的 `transformMessages` 在发送前补上 "No result provided"。我们选择当场为每个调用生成一个"被取消"的结果，让历史本身就是完整的。两种做法都保证了发给模型的历史合法。
- **参数校验**：[packages/ai/src/utils/validation.ts](../../packages/ai/src/utils/validation.ts) 的 `validateToolArguments`。pi 先用 `normalizeOptionalNulls` 处理可选参数为 null 的情况，再用 TypeBox 的 `Value.Convert` 做类型转换（对应我们的 `coerce`），然后用编译好的校验器检查。错误信息的格式是 `Validation failed for tool "…"` + 问题列表 + `Received arguments:`，和我们的一样。
- **默认并行执行**：pi 的 `executeToolCalls` 默认走 `executeToolCallsParallel`，除非配置了 `toolExecution: "sequential"`，或者某个工具声明了自己必须顺序执行。下一章我们也会实现。

## 15. 闭卷挑战

不看资料，在新文件里写出：

1. `runAgentLoop`：工作副本、三个停止条件、全部事件；
2. `executeToolCall`：五种错误情况，从不抛出异常，进度事件的顺序；
3. `validateValue`：至少支持 object（含 required）、string、number、array。

让 `test/agent-loop.test.ts` 和 `test/validate.test.ts` 全部通过。90 分钟内完成，你就真正掌握了 coding agent 的核心。

---

上一步：[里程碑 08：工具调用](../08-tools/README.md) · 下一步：[里程碑 10：Agent 类](../10-agent-class/README.md)
