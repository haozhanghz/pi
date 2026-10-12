# 里程碑 06：统一的消息与事件流

> 目标：把前几章的脚本，重构成 mini-pi 的第一个正式模块——`src/ai/`。它定义了整个项目通用的消息类型和流式事件，并通过"适配器"屏蔽不同服务商的差异。
>
> 完成后你将拥有：mini-pi 的 `ai` 层（类型、事件流、SSE 解析、OpenAI 适配器、统一入口）和第一批自动化测试。之后的所有代码都建立在它上面。

```
src/ai/
├── types.ts            消息、模型、事件的类型
├── event-stream.ts     EventStream：生产者推送、消费者 for await
├── sse.ts              SSE 解析（从里程碑 05 搬过来）
├── usage.ts            token 用量和费用
├── providers/
│   └── openai.ts       OpenAI 兼容协议的适配器
├── stream.ts           统一入口：stream() / complete()
└── index.ts            ai 层的公开接口
test/
├── event-stream.test.ts
├── sse.test.ts
├── openai.test.ts
└── helpers/fake-openai-server.ts
```

## 你将学到

- 从"脚本"到"项目"：按职责拆分模块，定义模块的公开接口
- **适配器模式**：用统一的接口包装各不相同的实现
- mini-pi 的核心类型：内容块、消息、用量、模型、上下文
- 流式事件协议：`start` → 块的 `start/delta/end` → `done` 或 `error`
- `EventStream`：把"推送"变成"拉取"的桥梁
- "从不抛出异常"的约定，以及它为什么能让上层代码更简单
- 用 `node:test` 写自动化测试

---

## 1. 从脚本到项目

到目前为止，我们写的都是单个文件的小脚本。`chat-stream.ts` 里混着四件事：读配置、发请求和解析响应、界面显示、对话历史管理。随着功能增加（工具调用、多家服务商、会话保存、终端界面……），这样的文件会迅速膨胀到没人看得懂。

从这一章开始，我们按照 **pi 的架构**来组织代码：

```
┌──────────────────────────────────────────────┐
│ modes：命令行、交互界面          （里程碑 13、18） │
├──────────────────────────────────────────────┤
│ core / tools：编程工具、会话、压缩  （里程碑 11~15） │
├──────────────────────────────────────────────┤
│ agent：Agent Loop、工具执行      （里程碑 09、10） │
├──────────────────────────────────────────────┤
│ ai：和大模型通信                 （本章、07、08）  │
└──────────────────────────────────────────────┘
```

每一层只依赖它下面的层。本章搭建最底下的 `ai` 层。

在 `my-pi` 里创建 `src/ai/` 和 `test/` 目录。`playground/` 里以前的脚本可以留着做纪念（参考答案里为了清晰把它们删掉了）。`package.json` 里加上两个脚本：

```json
	"scripts": {
		"check": "tsc",
		"test": "node --test test/*.test.ts"
	},
```

`npm test` 会运行 `test/` 目录下所有 `*.test.ts` 文件。（直接运行不带参数的 `node --test` 也可以，但它会把 `test/` 目录下的所有文件——包括辅助文件——都当成测试文件运行一遍，所以我们明确指定文件名模式。）

## 2. 问题：每家服务商都不一样

你已经熟悉了 OpenAI 格式的流式响应：

```
data: {"choices":[{"delta":{"content":"你好"}}]}
```

下一章要接入的 Anthropic，格式完全不同：

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}
```

Google、Mistral、AWS Bedrock……每一家都有自己的格式。如果界面代码、agent 代码直接处理这些格式，每接入一家新服务商，就要把所有上层代码改一遍。

**解决：适配器模式。** 我们定义一套**自己的**数据格式（消息类型 + 事件类型），然后为每家服务商写一个"适配器"，负责双向翻译：

```
            界面、agent 等上层代码
         只认识 Message 和 AssistantMessageEvent
                     │
              ┌──────▼──────┐
              │   stream()  │   根据 model.api 选择适配器
              └──┬───────┬──┘
     ┌───────────┘       └──────────┐
┌────▼─────────┐            ┌───────▼────────┐
│ openai.ts    │            │ anthropic.ts   │  （下一章）
│ 适配器        │            │ 适配器          │
└────┬─────────┘            └───────┬────────┘
     │                              │
DeepSeek、通义千问、Kimi、          Anthropic，以及兼容
智谱、Ollama、OpenAI……              它的服务
```

上层代码只和中间那一层打交道。接入新服务商 = 写一个新适配器，上层一行都不用改。

这正是 pi 的 `packages/ai` 包做的事情，也是 pi 能支持几十家服务商的原因。

## 3. 核心类型（src/ai/types.ts）

类型是整个设计的骨架，我们先把它定下来。完整文件：[code/src/ai/types.ts](code/src/ai/types.ts)。

### 3.1 内容块

```ts
export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	signature?: string;
}
```

模型的一条回复由若干**内容块**组成。为什么不直接用一个字符串？因为一条回复里可能有多种内容，而且顺序有意义：

```
[ thinking: "用户想要……我应该先读文件", text: "我来看看这个文件。", toolCall: read(...) ]
```

本章先支持文字和思考两种块，里程碑 08 会加上工具调用块。

`signature` 是"发回思考内容时需要的信息"。之前几轮的思考内容不需要发回给模型，但在里程碑 08 的工具调用循环里，**当前这一轮**的思考内容必须原样发回去。我们现在就把需要的信息记下来：对 OpenAI 兼容接口，记下思考内容来自哪个字段（比如 `reasoning_content`）；对 Anthropic，记下它返回的签名。

### 3.2 消息

```ts
export interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent)[];
	api: Api;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage;
```

和里程碑 01 的 `messages.ts` 很像，但 `AssistantMessage` 多记录了很多信息。每个字段都有用处：

| 字段 | 为什么需要 |
| --- | --- |
| `api`、`provider`、`model` | 这条回复是谁生成的。一个会话中途可以切换模型，以后看历史时要知道每条回复来自哪个模型 |
| `usage` | 这次用了多少 token、花了多少钱。界面底部的统计就靠它 |
| `stopReason` | 为什么停止：正常结束、被截断、出错、被取消 |
| `errorMessage` | 出错时的原因 |
| `timestamp` | 什么时候生成的 |

```ts
export type StopReason = "stop" | "length" | "error" | "aborted";
```

注意 `error` 和 `aborted` 也是一种"停止原因"。**出错的回复也是一条消息**，这个设计在第 6 节会显示出它的威力。

### 3.3 用量

```ts
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

`cacheRead` 是"命中缓存的输入 token"。上一章提到过：服务商会缓存请求开头相同的部分，命中缓存的 token 便宜得多（常常只有原价的十分之一）。coding agent 每轮都会重发大量相同的历史，缓存能省很多钱，所以要单独统计。

费用按"每百万 token 多少美元"计算（[code/src/ai/usage.ts](code/src/ai/usage.ts)）：

```ts
export function calculateCost(model: Model, usage: Usage): void {
	usage.cost.input = (usage.input * model.cost.input) / 1_000_000;
	usage.cost.output = (usage.output * model.cost.output) / 1_000_000;
	usage.cost.cacheRead = (usage.cacheRead * model.cost.cacheRead) / 1_000_000;
	usage.cost.cacheWrite = (usage.cacheWrite * model.cost.cacheWrite) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
```

（`1_000_000` 里的下划线只是为了好读，等于 `1000000`。）

### 3.4 模型、上下文、选项

```ts
export type Api = "openai-completions";

export interface Model {
	id: string;            // 发给服务商的模型名，例如 "deepseek-chat"
	name: string;          // 给人看的名字
	api: Api;              // 用哪种协议
	provider: string;      // 哪家服务商
	baseUrl: string;
	reasoning: boolean;    // 是不是推理模型
	contextWindow: number; // 上下文窗口
	maxTokens: number;     // 最多输出多少 token
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
}

export interface StreamOptions {
	apiKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
}
```

注意 `api` 和 `provider` 的区别：`provider` 是"谁家的服务"，`api` 是"说什么协议"。DeepSeek、Kimi、通义千问是不同的 provider，但都说 `openai-completions` 协议，所以用同一个适配器。

`Context` 是"一次请求需要的全部上下文"。把它和 `Model`、`StreamOptions` 分开，是因为它们变化的频率不同：模型很少换，选项每次请求可能不同，上下文每轮都在增长。

## 4. 流式事件协议

所有适配器都要把服务商的流式响应翻译成同一套事件：

```ts
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "done"; reason: "stop" | "length"; message: AssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };
```

一次成功的回复，事件的顺序是这样的：

```
start                          回复开始了
thinking_start  contentIndex=0  第 0 块（思考）开始
thinking_delta  "用户想……"
thinking_delta  "……"
thinking_end    contentIndex=0  第 0 块结束，content 是完整的思考内容
text_start      contentIndex=1  第 1 块（文字）开始
text_delta      "你好"
text_delta      "！"
text_end        contentIndex=1
done            reason="stop"   回复结束，message 是完整的回复
```

为什么设计成这样？

- **`*_start` / `*_end`**：界面需要知道"一个新的块开始了"（创建一个新的显示区域）和"这个块结束了"（比如把思考内容折叠起来）。只有 delta 是不够的。
- **`contentIndex`**：这个事件属于第几个块。将来一条回复里可能有好几个工具调用，界面要知道该更新哪一个。
- **`partial`**：到目前为止的完整回复。界面可以直接用它重新绘制，而不用自己拼接 delta。注意它是**同一个对象**，会随着新事件不断变化；如果要保存某一时刻的样子，要自己复制一份。
- **以 `done` 或 `error` 结束**：保证消费者一定能知道"结束了"。

协议的几条规则：

1. 成功的流：先 `start`，然后若干块事件，最后 `done`。
2. 请求在开始之前就失败了（比如 key 错误），可以只有一个 `error`，没有 `start`。
3. 开始之后出错（比如网络中断、用户取消），以 `error` 结束；`error.error` 里保留着已经收到的内容。

## 5. EventStream：推送变拉取

**问题**：适配器是**生产者**，它在后台一边读网络数据一边产生事件，节奏由网络决定，这是"推送"（push）。界面是**消费者**，它想用 `for await` 一个一个地取事件，这是"拉取"（pull）。两边节奏不同：有时生产者快（事件堆积），有时消费者快（要等事件）。怎么把它们接起来？

**解决**：一个带队列的中间对象，这就是 `EventStream`（[code/src/ai/event-stream.ts](code/src/ai/event-stream.ts)）。

```ts
export class EventStream<T, R> implements AsyncIterable<T> {
	private queue: T[] = [];                                       // 已推送、未取走的事件
	private waiting: ((result: IteratorResult<T>) => void)[] = []; // 正在等待的消费者
	private done = false;
	private finalResult: Promise<R>;
	private resolveFinal: (result: R) => void = () => {};
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;
	// ……
}
```

两个泛型参数：`T` 是事件类型，`R` 是最终结果类型。`AssistantMessageEventStream` 就是 `EventStream<AssistantMessageEvent, AssistantMessage>`。

**生产者这一侧**，`push`：

```ts
push(event: T): void {
	if (this.done) return;
	if (this.isComplete(event)) {
		this.done = true;
		this.resolveFinal(this.extractResult(event));
	}
	const waiter = this.waiting.shift();
	if (waiter) waiter({ value: event, done: false });
	else this.queue.push(event);
}
```

有消费者在等，就直接把事件交给它；没人等，就放进队列。如果这是最后一个事件（`done` 或 `error`），顺便把最终结果兑现。

**消费者这一侧**，实现 `[Symbol.asyncIterator]`，这样就可以被 `for await` 使用：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T> {
	while (true) {
		if (this.queue.length > 0) {
			yield this.queue.shift() as T;      // 队列里有，直接取
		} else if (this.done) {
			return;                             // 没有了，而且结束了
		} else {
			const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
			if (result.done) return;
			yield result.value;                 // 等到了一个新事件
		}
	}
}
```

最巧妙的是第三个分支：消费者创建一个 Promise，把它的 `resolve` 函数放进 `waiting` 列表，然后 `await`。等生产者 `push` 时，从 `waiting` 里取出这个 `resolve` 并调用它，消费者就被"叫醒"了。

用一个例子走一遍：

```
消费者：for await 开始，队列空，没结束 → 把 resolve₁ 放进 waiting，等待
生产者：push(start)        → waiting 里有 resolve₁，调用它 → 消费者拿到 start
消费者：处理 start（比如创建界面元素），这期间……
生产者：push(text_start)   → waiting 空 → 放进队列 [text_start]
生产者：push(text_delta)   → 放进队列 [text_start, text_delta]
消费者：回到循环，队列不空 → 取出 text_start；再循环，取出 text_delta
消费者：队列空 → 把 resolve₂ 放进 waiting，等待
生产者：push(done)         → done = true，兑现最终结果，调用 resolve₂ → 消费者拿到 done
消费者：队列空，已结束 → return，for await 循环结束
```

`result()` 返回最终结果的 Promise。如果你不关心中间过程，只要完整回复，直接 `await stream.result()` 就行。

`end()` 用来结束流，并叫醒所有还在等待的消费者（告诉它们"没有更多了"）。

## 6. 约定：适配器从不抛出异常

这是一个看起来不起眼、却影响深远的设计决定：

> **`stream()` 从不抛出异常。** 网络错误、HTTP 错误、用户取消，全部变成一个 `error` 事件；最终结果是一条 `stopReason` 为 `"error"` 或 `"aborted"` 的 `AssistantMessage`，`errorMessage` 说明原因。

**问题**：如果出错时抛异常，消费者要写两套代码：

```ts
try {
	for await (const event of stream(...)) { /* 正常处理 */ }
} catch (error) {
	/* 出错处理：已经收到的内容怎么办？ */
}
```

而且异常可能在三个地方抛出：调用 `stream()` 时、迭代过程中、`await result()` 时。很容易漏掉一个。

**解决**：把错误当成**数据**。消费者只有一条路径：

```ts
const response = stream(model, context, options);
for await (const event of response) { /* 处理事件 */ }
const message = await response.result();
if (message.stopReason === "error") { /* 显示 message.errorMessage */ }
```

还有一个好处：出错的回复也是一条正常的 `AssistantMessage`，可以和其他消息一样**保存进会话历史**、显示在界面上。用户以后回看会话时，能看到"这里出过一个错，原因是……"。

pi 的 `packages/ai/src/types.ts` 里，`StreamFunction` 的注释明确写着这条约定：

```ts
// Contract:
// ……
// - Must return an AssistantMessageEventStream.
// - …… Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
```

## 7. OpenAI 适配器（src/ai/providers/openai.ts）

完整代码：[code/src/ai/providers/openai.ts](code/src/ai/providers/openai.ts)。下面分段讲解。

### 7.1 请求：把 Context 翻译成 OpenAI 格式

```ts
export function convertMessages(context: Context): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	if (context.systemPrompt) {
		result.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages) {
		switch (message.role) {
			case "user":
				result.push({ role: "user", content: message.content });
				break;
			case "assistant": {
				const text = message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
				if (text.length === 0) break;
				result.push({ role: "assistant", content: text });
				break;
			}
		}
	}
	return result;
}
```

- 系统提示词变成第一条 `system` 消息（我们的 `Context` 把它单独存放，OpenAI 把它当作一条消息——这就是"翻译"）。
- 助手消息的内容块拼成一个字符串（OpenAI 的 assistant 消息用字符串）。
- 没有文字的助手消息（比如刚开始就被取消了）不发送，很多服务商会拒绝空消息。
- 思考内容不发回去。之前几轮的思考对模型没有用处，DeepSeek 等服务商的文档也明确要求不要把它们放进新的请求。（里程碑 08 会遇到一个例外：工具调用循环中，当前这一轮的思考内容必须发回。）

请求体：

```ts
function buildRequestBody(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(context),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	return body;
}
```

### 7.2 用量和停止原因

```ts
function parseUsage(raw: OpenAIUsage, model: Model): Usage {
	const usage = createEmptyUsage();
	const prompt = raw.prompt_tokens ?? 0;
	const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
	usage.input = Math.max(0, prompt - cached);
	usage.cacheRead = cached;
	usage.output = raw.completion_tokens ?? 0;
	usage.totalTokens = usage.input + usage.cacheRead + usage.output;
	calculateCost(model, usage);
	return usage;
}
```

"兼容"的服务商也不是完全一样：OpenAI 用 `prompt_tokens_details.cached_tokens` 报告缓存命中，DeepSeek 用 `prompt_cache_hit_tokens`。适配器要把这些差异抹平。`prompt_tokens` 包含了缓存命中的部分，所以要减掉，`input` 只算没命中的。

```ts
function mapStopReason(reason: string | undefined): { stopReason: "stop" | "length" | "error"; errorMessage?: string } {
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case undefined:
			return { stopReason: "error", errorMessage: "响应在没有 finish_reason 的情况下结束了（连接可能中断了）" };
		default:
			return { stopReason: "error", errorMessage: `服务商返回了意外的停止原因：${reason}` };
	}
}
```

如果流结束了却一直没收到 `finish_reason`，说明连接很可能中途断了，回复不完整，我们把它当作错误。

### 7.3 主流程

```ts
export function streamOpenAI(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			// ……发请求、解析、推送事件……
		} catch (error) {
			// ……推送 error 事件……
		}
	})();

	return stream;
}
```

结构上有两个要点：

1. **立即返回 stream**。真正的工作放在一个立即执行的 `async` 函数里（`(async () => { ... })()`），它在后台运行。调用者拿到 stream 后马上就可以开始 `for await`。
2. **`output` 就是那个不断被填充的 `partial`**。每收到一点内容就修改它，然后推送事件。

### 7.4 一次只有一个"打开"的块

收到的 delta 可能是思考内容，也可能是正文。我们用一个变量 `current` 记住"当前正在接收的块"：

- 收到思考内容，而当前块不是思考块：结束当前块（发出 `*_end`），新建一个思考块（发出 `thinking_start`）。
- 收到正文，而当前块不是文字块：同理。
- 收到的类型和当前块相同：直接追加，发出 `*_delta`。

```ts
let current: TextContent | ThinkingContent | undefined;

const endCurrent = () => {
	if (!current) return;
	const contentIndex = output.content.length - 1;
	if (current.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: current.text, partial: output });
	} else {
		stream.push({ type: "thinking_end", contentIndex, content: current.thinking, partial: output });
	}
	current = undefined;
};
```

处理正文的部分：

```ts
if (delta.content) {
	if (current?.type !== "text") {
		endCurrent();
		current = { type: "text", text: "" };
		output.content.push(current);
		stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
	}
	current.text += delta.content;
	stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: delta.content, partial: output });
}
```

注意 `current` 和 `output.content` 里的最后一个元素是**同一个对象**，所以 `current.text += ...` 同时也更新了 `output`（也就是 `partial`）。

用一个例子走一遍。假设收到的 chunk 依次是：

```
① delta.reasoning_content = "想"
② delta.reasoning_content = "想看"
③ delta.content = "答案"
④ finish_reason = "stop"
```

产生的事件：

```
①  current 为空，不是 thinking → 新建思考块      thinking_start(0)、thinking_delta(0,"想")
②  current 是 thinking → 直接追加               thinking_delta(0,"想看")
③  current 是 thinking，不是 text → 结束思考块   thinking_end(0,"想想看")
    新建文字块                                   text_start(1)、text_delta(1,"答案")
④  记下 finish_reason
流结束 → endCurrent()                           text_end(1,"答案")
                                                 done
```

### 7.5 结束与出错

```ts
	endCurrent();
	if (options.signal?.aborted) throw new Error("请求被取消");
	const { stopReason, errorMessage } = mapStopReason(finishReason);
	if (stopReason === "error") throw new Error(errorMessage);
	output.stopReason = stopReason;
	stream.push({ type: "done", reason: stopReason, message: output });
	stream.end();
} catch (error) {
	const reason = options.signal?.aborted ? "aborted" : "error";
	output.stopReason = reason;
	output.errorMessage = reason === "aborted" ? "请求被取消" : error instanceof Error ? error.message : String(error);
	stream.push({ type: "error", reason, error: output });
	stream.end();
}
```

所有出错的情况（HTTP 错误、网络中断、取消、意外的停止原因）都汇集到 `catch` 里，变成一个 `error` 事件。怎么区分"出错"和"被取消"？看 `signal.aborted`：用户主动取消时它是 `true`。

HTTP 错误时，服务商通常在响应体里返回 `{ "error": { "message": "..." } }`，我们把这个信息提取出来放进 `errorMessage`，用户才能知道到底错在哪里（见 `describeHttpError`）。

## 8. 统一入口和公开接口

`src/ai/stream.ts`：

```ts
export function stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream {
	switch (model.api) {
		case "openai-completions":
			return streamOpenAI(model, context, options);
		default: {
			const unknownApi: never = model.api;
			throw new Error(`不支持的接口协议：${unknownApi}`);
		}
	}
}

export function complete(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}
```

现在只有一种协议，下一章会加上 `anthropic-messages` 和 `faux`。`default` 分支里的 `never` 检查保证：以后给 `Api` 加了新协议，却忘了在这里处理，tsc 会报错。

`src/ai/index.ts` 是 ai 层的**公开接口**：

```ts
export * from "./event-stream.ts";
export { convertMessages as convertOpenAIMessages, streamOpenAI } from "./providers/openai.ts";
export * from "./sse.ts";
export * from "./stream.ts";
export type * from "./types.ts";
export * from "./usage.ts";
```

约定：**其他层只从 `src/ai/index.ts` 导入，不直接导入 ai 目录里的其他文件。** 这样 ai 层内部怎么重构都不会影响外面。pi 的每个包也都有这样一个 `index.ts`。

`export type * from` 表示"把这个文件里的所有类型重新导出"，因为 `types.ts` 里只有类型。

## 9. 自动化测试

从现在开始，代码越来越多，每次改动后都手动跑一遍所有程序来确认没改坏，是不现实的。我们需要**自动化测试**：用代码检查代码。

Node 内置了测试框架 `node:test`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

test("1 加 1 等于 2", () => {
	assert.equal(1 + 1, 2);
});
```

- `test(名字, 函数)` 定义一个测试，函数可以是 `async` 的。
- `assert.equal(实际, 期望)` 判断相等；`assert.deepEqual` 比较对象和数组的内容；`assert.match(字符串, 正则)` 判断字符串匹配；`assert.ok(条件)` 判断为真。
- 断言失败会抛出异常，这个测试就算失败。

运行 `npm test`，会看到：

```
# tests 21
# pass 21
# fail 0
```

### 测试适配器：一个迷你的假服务器

测试 OpenAI 适配器需要一个能返回指定数据的服务器。[code/test/helpers/fake-openai-server.ts](code/test/helpers/fake-openai-server.ts) 用 `node:http` 实现了一个，大约 80 行：你告诉它"第一个请求返回这些 chunk，第二个请求返回 401"，它就照做，同时记录收到的每个请求。

一个典型的测试（[code/test/openai.test.ts](code/test/openai.test.ts)）：

```ts
test("文字回复：事件顺序是 start → text_start → text_delta… → text_end → done", async () => {
	const server = await serve({
		chunks: [textChunk("你"), textChunk("好"), finishChunk("stop"), usageChunk(10, 2)],
	});
	const response = stream(makeModel(server.baseUrl), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "k" });
	const events = await collect(response);
	assert.deepEqual(
		events.map((e) => e.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	const message = await response.result();
	assert.deepEqual(message.content, [{ type: "text", text: "你好" }]);
	assert.equal(message.usage.input, 10);
});
```

测试覆盖了：事件顺序、请求格式、思考内容、历史里的思考内容不发回、截断、HTTP 错误、连不上服务器、连接中断、取消。**每一个测试都对应一个你在真实使用中可能遇到的情况。** 以后修改适配器时，只要测试全部通过，你就有信心没有改坏东西。

## 10. 用新的 ai 层重写聊天程序

[code/playground/ai-chat.ts](code/playground/ai-chat.ts) 用 `src/ai` 重写了上一章的流式聊天。核心部分：

```ts
const response = stream(model, { systemPrompt, messages }, { apiKey, signal: current.signal });

for await (const event of response) {
	switch (event.type) {
		case "thinking_start":
			process.stdout.write(dim("（思考中）"));
			break;
		case "thinking_delta":
			process.stdout.write(dim(event.delta));
			break;
		case "thinking_end":
			process.stdout.write("\n助手> ");
			break;
		case "text_delta":
			process.stdout.write(event.delta);
			break;
	}
}

const message = await response.result();
switch (message.stopReason) {
	case "error":   /* 撤回用户消息，显示错误 */ break;
	case "aborted": /* 有内容就保留 */ break;
	default:        messages.push(message);
}
```

和 `chat-stream.ts` 对比：

- 没有任何 OpenAI 的格式细节（`choices`、`delta`、`[DONE]`）。
- 没有 `try/catch`。
- 历史里直接存 `AssistantMessage`，包含了用量、模型等完整信息。

这就是分层的好处：界面代码只关心"显示什么"。

运行（`.env` 配置同里程碑 03）：

```bash
node --env-file=.env playground/ai-chat.ts
```

## 11. 接口约定与测试

如果你想不看参考答案自己实现，请遵守下面的接口，然后把参考答案的 `test/` 目录复制到你的项目里运行 `npm test`：

| 文件 | 导出 |
| --- | --- |
| `src/ai/types.ts` | `TextContent`、`ThinkingContent`、`UserMessage`、`AssistantMessage`、`Message`、`StopReason`、`Usage`、`Api`、`Model`、`Context`、`StreamOptions`、`AssistantMessageEvent`（字段见第 3、4 节） |
| `src/ai/event-stream.ts` | `class EventStream<T, R>`（构造参数 `isComplete`、`extractResult`；方法 `push`、`end`、`result`；可被 `for await` 迭代），`class AssistantMessageEventStream` |
| `src/ai/sse.ts` | `parseSSE(bytes)`、`SseEvent` |
| `src/ai/usage.ts` | `createEmptyUsage()`、`calculateCost(model, usage)` |
| `src/ai/providers/openai.ts` | `streamOpenAI(model, context, options?)`、`convertMessages(context)` |
| `src/ai/stream.ts` | `stream(model, context, options?)`、`complete(model, context, options?)` |
| `src/ai/index.ts` | 以上全部 |

行为约定：见第 4 节（事件顺序）和第 6 节（从不抛出异常）。

## 12. 常见错误

| 现象 | 原因 |
| --- | --- |
| `for await` 永远不结束 | 适配器在某条路径上忘了 `stream.end()`，或者没有推送 `done`/`error` |
| `await response.result()` 永远不兑现 | 同上；或者 `isComplete` 判断写错了 |
| 界面上的文字重复 | 同时用了 `delta` 和 `partial` 来显示 |
| 测试时进程不退出 | 测试结束时没有关闭假服务器（`after(() => server.close())`） |
| 出错时程序崩溃，而不是显示错误 | 适配器里有一段代码不在 `try` 里面，异常逃逸了 |
| tsc 报 `'Message' is a type and must be imported using a type-only import` | 导入类型时漏了 `type` 关键字 |

## 13. 练习

1. **调试钩子**：给 `StreamOptions` 加一个 `onPayload?: (body: unknown) => void`，适配器发请求前调用它。在 `ai-chat.ts` 里用它把请求体打印出来（只在设置了环境变量 `DEBUG=1` 时打印）。pi 也有同名的选项，调试时非常有用。
2. **首字延迟**：在 `ai-chat.ts` 里，利用事件计算"从发出请求到收到第一个 `text_delta` 的时间"和"每秒输出多少字"。
3. **取文字的小工具**：在 `src/ai/` 里写一个 `getText(message: AssistantMessage): string`，返回所有文字块拼起来的内容，并为它写测试。
4. **再写一个测试**：为"服务器返回 429 时，`errorMessage` 包含 429"写一个测试。
5. **读 pi 的事件流**：打开 [packages/ai/src/utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts)，pi 的 `FifoQueue` 用两个数组实现队列，为什么不直接用一个数组的 `shift()`？（提示：查一查 `Array.prototype.shift` 的时间复杂度。）

## 14. 自测问题

1. 适配器模式解决了什么问题？
2. `api` 和 `provider` 有什么区别？举个例子。
3. 为什么回复要设计成"内容块数组"，而不是一个字符串？
4. `partial` 和 `delta` 有什么区别？显示文字时应该用哪个？
5. `EventStream` 里的 `waiting` 列表是做什么用的？
6. "从不抛出异常"的约定有哪些好处？
7. 为什么 `streamOpenAI` 要先返回 stream，再在后台工作？

<details>
<summary>参考答案</summary>

1. 不同服务商的数据格式不同。适配器把它们统一翻译成我们自己的格式，上层代码只需要认识一种格式，接入新服务商不需要修改上层代码。
2. `provider` 是服务商（谁家的服务），`api` 是协议（数据格式）。DeepSeek 和 Kimi 是两个 provider，但都使用 `openai-completions` 这个 api。
3. 一条回复可能同时包含思考、文字、工具调用等多种内容，而且顺序有意义。
4. `delta` 是这次新增的内容，`partial` 是到目前为止的完整回复。增量显示用 `delta`（追加到屏幕上）；需要整体重绘时用 `partial`。两个只用一个，否则会重复。
5. 保存"正在等待下一个事件的消费者"的 resolve 函数。生产者推送事件时，如果有人在等，就直接调用它把事件交过去。
6. 消费者只有一条代码路径；出错的回复也是一条正常的消息，可以保存和显示；不会因为漏掉某个 try/catch 而崩溃。
7. 这样调用者能立刻开始 `for await` 消费事件，实现真正的流式效果。如果等全部完成再返回，就失去了流式的意义。

</details>

## 15. 对照 pi 源码

| mini-pi | pi | 说明 |
| --- | --- | --- |
| `src/ai/types.ts` | [packages/ai/src/types.ts](../../packages/ai/src/types.ts) | pi 多了图片、工具调用（下一章）、系统消息、几十个服务商的配置类型 |
| `src/ai/event-stream.ts` | [packages/ai/src/utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts) | 结构完全一致；pi 用 `FifoQueue` 优化性能，并且自动记录每次回复的耗时 `durationMs` |
| `src/ai/providers/openai.ts` | [packages/ai/src/api/openai-completions.ts](../../packages/ai/src/api/openai-completions.ts) | 搜索 `export const stream`，看 pi 的主流程 |
| `src/ai/usage.ts` | `calculateCost`，在 [packages/ai/src/models.ts](../../packages/ai/src/models.ts) | |

在 pi 的 `openai-completions.ts` 里，你会认出这些熟悉的结构：

- `const output: AssistantMessage = { role: "assistant", content: [], ... stopReason: "pending" ... }`——就是我们的 `output`。
- `stream.push({ type: "start", partial: output })`——拿到响应后推送 `start`。
- `ensureTextBlock()`、`ensureThinkingBlock()`——"如果当前没有这种块就新建一个"，和我们的逻辑相同。pi 的实现允许思考块和文字块同时"打开"，所有块的 `*_end` 在最后统一发出（`finishBlock`）。
- `parseChunkUsage()`——处理 `cached_tokens`、`prompt_cache_hit_tokens` 等各家不同的缓存字段，注释里详细说明了每家服务商的差异。
- `mapStopReason()`——翻译 `finish_reason`。
- 最后的 `catch` 块——`output.stopReason = options?.signal?.aborted ? "aborted" : "error"`，然后推送 `error` 事件。和我们的一模一样。

pi 还有一个 `detectCompat()` 函数，根据服务商自动调整各种细节（比如有的服务商要求 `max_tokens`，有的要求 `max_completion_tokens`；DeepSeek 要求助手消息带上 `reasoning_content`）。这些"兼容性细节"占了 pi 适配器代码的一大半，也是"真实世界"和"教学版本"最大的区别。

## 16. 闭卷挑战

不看资料，从零写出 `EventStream` 和只支持文字的 `streamOpenAI`，让 `test/event-stream.test.ts` 和 `test/openai.test.ts` 里与文字有关的测试通过。能在 60 分钟内完成，你就掌握了 ai 层最核心的部分。

---

上一步：[里程碑 05：流式输出](../05-streaming/README.md) · 下一步：[里程碑 07：第二个服务商与模型注册表](../07-providers/README.md)
