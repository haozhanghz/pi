# 里程碑 07：第二个服务商与模型注册表

> 目标：接入第二种协议（Anthropic Messages），验证上一章的抽象是否真的好用；写一个进程内的"假模型"专门用于测试；建立一张模型表，让用户用一个名字就能选择任意服务商的模型。
>
> 完成后你将拥有：三个适配器（`openai-completions`、`anthropic-messages`、`faux`）、模型注册表 `models.ts`，以及可以用 `--model 服务商/模型名` 切换模型的聊天程序。

```
src/ai/
├── providers/
│   ├── openai.ts
│   ├── anthropic.ts    新增：Anthropic Messages 协议
│   └── faux.ts         新增：进程内的假模型，用于测试
├── models.ts           新增：服务商和模型表
├── http.ts             新增：从 openai.ts 抽出来的 HTTP 错误处理
└── ……
```

## 你将学到

- Anthropic Messages 协议和 OpenAI 协议的区别
- 一个结构更清晰的流式协议：每个内容块都有明确的开始、增量和结束
- 用"假实现"代替真实依赖来写测试
- 数据驱动的配置：用一张表描述服务商和模型
- 为什么"接入第二个实现"是检验抽象的最好办法

---

## 1. 为什么现在接入第二个服务商

上一章我们设计了统一的消息和事件类型，并声称"接入新服务商时，上层代码一行都不用改"。这句话对不对？只有一个适配器时是没法验证的——你很容易在不知不觉中，把 OpenAI 的某些特点"焊死"在了统一的类型里。

**检验一个抽象的最好办法，就是给它第二个实现。** 如果第二个实现写起来很别扭，需要修改统一的类型，说明抽象设计得不好；如果能自然地放进去，上层代码真的不用改，说明抽象是对的。

我们选择 Anthropic Messages 协议，原因有三个：

1. 它和 OpenAI 协议差别很大，是很好的"压力测试"。
2. pi 的作者主要用 Claude 模型开发 pi，这是 pi 里最重要的适配器之一。
3. 不少国内服务商也提供了 Anthropic 兼容的接口（比如 DeepSeek），你不一定需要 Anthropic 的账户也能测试它。课程的假模型服务器同样支持这个协议。

## 2. Anthropic Messages 协议

### 2.1 请求的区别

同一个请求，两种协议的写法：

| | OpenAI Chat Completions | Anthropic Messages |
| --- | --- | --- |
| 地址 | `{base}/chat/completions` | `{base}/v1/messages` |
| 认证 | `Authorization: Bearer {key}` | `x-api-key: {key}` |
| 版本 | 无 | 必须有请求头 `anthropic-version: 2023-06-01` |
| 系统提示词 | 一条 `role: "system"` 的消息 | 请求体里单独的 `system` 字段 |
| 最大输出 | `max_tokens` 可选 | `max_tokens` **必填** |
| 助手消息内容 | 字符串 | 内容块数组 `[{ "type": "text", "text": "..." }]` |

用 curl 试一试（先启动假模型服务器）：

```bash
curl http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"fake-model","max_tokens":1000,"system":"你是助手","messages":[{"role":"user","content":"你好"}]}'
```

再去掉 `max_tokens` 试一次，看看服务器返回什么错误。

> 一个容易踩的坑：新一代的 Claude 模型**不接受** `temperature` 参数，传了会返回 400 错误。所以我们只在用户明确设置时才发送它。服务商的 API 会不断变化，这也是为什么适配器里会积累很多"兼容性细节"。

### 2.2 流式响应

加上 `"stream": true`，Anthropic 返回的事件流是这样的：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","role":"assistant","content":[],"usage":{"input_tokens":21,"output_tokens":1}}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你说"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"的是"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":45}}

event: message_stop
data: {"type":"message_stop"}
```

和 OpenAI 相比：

- 每个事件都有 `event:` 字段（我们的 `parseSSE` 早就支持了，记得吗？），`data` 里的 `type` 和它相同。
- **每个内容块都有明确的开始（`content_block_start`）和结束（`content_block_stop`）**，用 `index` 标识是第几个块。这和我们自己设计的事件协议几乎一样！
- 用量分两次报告：`message_start` 报告输入 token，`message_delta` 报告输出 token。
- 停止原因叫 `stop_reason`，取值也不同：`end_turn`（正常结束）、`max_tokens`（被截断）、`tool_use`（要调用工具，下一章）、`refusal`（模型拒绝了请求）等。
- `ping` 事件用来保持连接，直接忽略。
- 流中途出错时，服务器会发来一个 `event: error`，比如服务器过载：`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`。

思考块（推理模型的思考过程）的事件类似：

```
content_block_start   {"index":0,"content_block":{"type":"thinking","thinking":""}}
content_block_delta   {"index":0,"delta":{"type":"thinking_delta","thinking":"让我想想……"}}
content_block_delta   {"index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAh..."}}
content_block_stop    {"index":0}
```

最后的 `signature_delta` 是一个**签名**：Anthropic 用它验证"这段思考确实是模型生成的，没有被篡改"。如果以后要把这段思考发回给模型（下一章的工具循环会需要），必须原样带上签名。我们把它存进 `ThinkingContent.signature`——上一章预留的字段派上用场了。

## 3. 实现 Anthropic 适配器

完整代码：[code/src/ai/providers/anthropic.ts](code/src/ai/providers/anthropic.ts)。结构和 `openai.ts` 完全一样：翻译请求、发送、翻译事件、出错时推送 `error` 事件。下面只讲不同的地方。

### 3.1 翻译请求

```ts
export function convertMessages(context: Context): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];
	for (const message of context.messages) {
		switch (message.role) {
			case "user":
				result.push({ role: "user", content: message.content });
				break;
			case "assistant": {
				const blocks: AnthropicContentBlock[] = message.content
					.filter((block): block is TextContent => block.type === "text" && block.text.length > 0)
					.map((block) => ({ type: "text", text: block.text }));
				if (blocks.length === 0) break;
				result.push({ role: "assistant", content: blocks });
				break;
			}
		}
	}
	return result;
}

function buildRequestBody(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens: options.maxTokens ?? model.maxTokens,
		messages: convertMessages(context),
		stream: true,
	};
	if (context.systemPrompt) body.system = context.systemPrompt;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	return body;
}
```

注意系统提示词：OpenAI 适配器把它变成第一条消息，Anthropic 适配器把它放进 `system` 字段。**同一个统一的 `Context`，两种翻译方式**——这正是适配器的意义。我们把系统提示词单独放在 `Context.systemPrompt` 里而不是当作一条消息，事实证明是对的：这样两种协议都很好翻译。

### 3.2 翻译事件：用 index 找到对应的块

```ts
const blocks = new Map<number, TextContent | ThinkingContent>();
let stopReason: string | null | undefined;

for await (const sse of parseSSE(response.body)) {
	const event = JSON.parse(sse.data) as AnthropicStreamEvent;
	switch (event.type) {
		case "message_start":
			applyUsage(event.message.usage);
			break;

		case "content_block_start": {
			const kind = event.content_block.type;
			if (kind === "text") {
				const block: TextContent = { type: "text", text: event.content_block.text ?? "" };
				output.content.push(block);
				blocks.set(event.index, block);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			} else if (kind === "thinking") {
				// ……同理，创建思考块……
			}
			break;
		}

		case "content_block_delta": {
			const block = blocks.get(event.index);
			if (!block) break;
			const contentIndex = output.content.indexOf(block);
			const delta = event.delta;
			if (delta.type === "text_delta" && block.type === "text" && delta.text) {
				block.text += delta.text;
				stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
			} else if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking) {
				// ……追加思考内容……
			} else if (delta.type === "signature_delta" && block.type === "thinking" && delta.signature) {
				block.signature = (block.signature ?? "") + delta.signature;
			}
			break;
		}

		case "content_block_stop":
			// ……推送 text_end 或 thinking_end……
			break;

		case "message_delta":
			if (event.delta.stop_reason !== undefined) stopReason = event.delta.stop_reason;
			applyUsage(event.usage);
			break;

		case "error":
			throw new Error(`${event.error.type}：${event.error.message}`);
	}
}
```

为什么要用一个 `Map` 把 Anthropic 的 `index` 映射到我们的块，而不是直接用 `index` 当作 `contentIndex`？因为 Anthropic 可能发来我们**不认识**的块类型（比如新功能产生的新块），我们会跳过它们。一旦跳过了某个块，Anthropic 的编号和我们的编号就对不上了。用 `Map` 记录对应关系，遇到不认识的块时 `blocks.get(index)` 返回 `undefined`，直接忽略即可。

这种"遇到不认识的东西就跳过，而不是报错"的做法，叫做**向前兼容**：服务商以后增加新的事件或块类型，我们的旧代码也不会崩溃。

### 3.3 用量

```ts
const applyUsage = (raw: AnthropicUsage | undefined) => {
	if (!raw) return;
	if (raw.input_tokens !== undefined) output.usage.input = raw.input_tokens;
	if (raw.output_tokens !== undefined) output.usage.output = raw.output_tokens;
	if (raw.cache_read_input_tokens !== undefined) output.usage.cacheRead = raw.cache_read_input_tokens;
	if (raw.cache_creation_input_tokens !== undefined) output.usage.cacheWrite = raw.cache_creation_input_tokens;
	const usage = output.usage;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	calculateCost(model, usage);
};
```

一个细节差异：OpenAI 的 `prompt_tokens` **包含**缓存命中的部分（所以上一章要减掉），Anthropic 的 `input_tokens` **不包含**缓存部分。统一之后，我们的 `usage.input` 在两种协议下含义相同：没有命中缓存的输入。这就是适配器要抹平的那种细微差别。

### 3.4 停止原因

```ts
function mapStopReason(reason: string | null | undefined) {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return { stopReason: "stop" };
		case "max_tokens":
		case "model_context_window_exceeded":
			return { stopReason: "length" };
		case "refusal":
			return { stopReason: "error", errorMessage: "模型拒绝了这个请求（stop_reason: refusal）" };
		case undefined:
		case null:
			return { stopReason: "error", errorMessage: "响应在没有 stop_reason 的情况下结束了（连接可能中断了）" };
		default:
			return { stopReason: "error", errorMessage: `服务商返回了意外的停止原因：${reason}` };
	}
}
```

### 3.5 抽出共用代码

两个适配器都需要"把 HTTP 错误整理成一句话"，而且 Anthropic 的错误格式 `{"type":"error","error":{"message":"..."}}` 和 OpenAI 的 `{"error":{"message":"..."}}` 恰好都能用 `error.message` 取出。我们把这个函数从 `openai.ts` 搬到 [code/src/ai/http.ts](code/src/ai/http.ts)，两个适配器共用。

写第二个实现时发现可以共用的代码，是很自然的事情。但不要过早抽象：只有一个适配器时，你很难猜对哪些东西是"共用的"。

## 4. 假模型：用于测试的适配器

### 4.1 问题

下一章开始写 Agent Loop：模型调用工具 → 执行 → 再调用模型……要测试这样的逻辑，我们需要一个**完全可控**的模型：第一次回复"调用 read 工具"，第二次回复"文件内容是……"。

用 HTTP 假服务器当然可以，但每个测试都要启动服务器、准备 SSE 格式的数据，很繁琐，也慢。

### 4.2 解决：进程内的假适配器

既然上层代码只认识 `stream()` 返回的事件流，那么我们完全可以写一个**不发网络请求**的适配器：它按照预先写好的剧本，直接产生事件。这就是 `faux`（法语"假的"），pi 里也有同名的东西。

用法：

```ts
const faux = createFauxModel([
	{ text: "第一句回复" },
	{ thinking: "想一想", text: "第二句" },
	{ error: "服务器开小差了" },
]);

const message = await stream(faux.model, { messages: [...] }).result();  // 得到"第一句回复"
faux.requests;    // 记录了收到的每个请求，可以检查发给模型的内容
faux.remaining;   // 剧本还剩几步
```

剧本的一步也可以是一个函数，根据收到的上下文临时决定回复：

```ts
createFauxModel([(context) => ({ text: `你一共发了 ${context.messages.length} 条消息` })]);
```

### 4.3 实现要点

完整代码：[code/src/ai/providers/faux.ts](code/src/ai/providers/faux.ts)。

**问题**：`stream(model, context)` 只接收一个 `Model` 对象，假适配器怎么知道该用哪份剧本？

**解决**：用一个模块级的 `Map`，以模型 id 为键保存每个假模型的状态。`createFauxModel` 生成一个唯一的 id（`faux-1`、`faux-2`……）并登记剧本；`streamFaux` 根据 `model.id` 找到它：

```ts
const states = new Map<string, FauxState>();
let counter = 0;

export function createFauxModel(steps: FauxStep[] = [], options: { contextWindow?: number } = {}): FauxHandle {
	const id = `faux-${++counter}`;
	const state: FauxState = { steps: [...steps], requests: [] };
	states.set(id, state);
	const model: Model = { id, name: "Faux Model", api: "faux", provider: "faux", /* …… */ };
	return { model, requests: state.requests, /* …… */ };
}
```

这样每个测试创建自己的假模型，互不干扰。

`streamFaux` 的主体和真实适配器一样：取出剧本的下一步，按"三个字一段"产生 `text_delta`，每段之间用 `setImmediate`（或者指定的延迟）让出控制权，模拟数据陆续到达，并检查 `signal.aborted` 支持取消。它还会粗略估算 token 用量（4 个字符算 1 个 token），里程碑 15 测试"上下文压缩"时会用到。

> 一个设计原则：**让被测试的代码看不出自己在被测试。** Agent Loop 调用 `stream()` 时，根本不知道背后是 DeepSeek、Anthropic 还是假模型。这正是统一抽象带来的另一个好处：可测试性。

## 5. 模型注册表

### 5.1 问题

用户想用 DeepSeek，需要知道：地址是 `https://api.deepseek.com`、协议是 `openai-completions`、key 放在哪个环境变量、上下文窗口多大、价格多少……每次手写一个 `Model` 对象太麻烦，也容易写错。

### 5.2 解决：一张表

[code/src/ai/models.ts](code/src/ai/models.ts) 用一个数组描述所有内置的服务商：

```ts
export const PROVIDERS: ProviderInfo[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [
			{ id: "deepseek-chat", name: "DeepSeek Chat", cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
			{ id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true, maxTokens: 32_768, cost: { /* …… */ } },
		],
	},
	// ……通义千问、Kimi、智谱、硅基流动、OpenRouter、OpenAI、Anthropic、Ollama……
];
```

这种做法叫**数据驱动**：增加一个服务商只需要在表里加一项，不需要写新的代码（只要它说的是我们已经支持的协议）。

几个设计细节：

- **默认参数**：服务商会不断推出新模型，表永远跟不上。所以没有列出来的模型名也可以使用，会套用服务商的 `defaults`。
- **价格**：每百万 token 多少美元。价格经常变化，表里只是例子，以官网为准。没有写价格的模型，费用就显示为 0。
- **API key**：每家服务商从各自的环境变量读取，比如 `DEEPSEEK_API_KEY`。你可以同时配置好几家，随时切换。本地服务（Ollama、假模型服务器）不需要 key，用 `defaultApiKey` 占位。
- **custom**：一个特殊的服务商，从 `LLM_BASE_URL` 等环境变量读取地址，兼容前几章的配置方式，也方便接入表里没有的服务。

### 5.3 用一个字符串选择模型

```ts
resolveModel("deepseek/deepseek-chat");       // 服务商/模型名
resolveModel("openrouter/openai/gpt-4o-mini"); // 模型名里可以有 /，只按第一个 / 切分
resolveModel("claude-sonnet-5-5");             // 只写模型名：在内置模型里查找
```

为什么"只按第一个 `/` 切分"？OpenRouter、硅基流动的模型名本身就带 `/`（比如 `openai/gpt-4o-mini`、`Qwen/Qwen2.5-7B-Instruct`）。所以我们先看第一个 `/` 前面是不是一个已知的服务商，是的话剩下的部分整个作为模型名。

pi 用的是同样的格式：`pi --model deepseek/deepseek-chat`。

## 6. 运行

列出所有服务商和模型，看看哪些已经配置了 key：

```bash
node playground/models.ts
```

```
fake                 假模型服务器（课程提供，OpenAI 协议）  [openai-completions]  已配置
    fake/fake-model
fake-anthropic       假模型服务器（课程提供，Anthropic 协议）  [anthropic-messages]  已配置
    fake-anthropic/fake-model
deepseek             DeepSeek  [openai-completions]  未配置（需要环境变量 DEEPSEEK_API_KEY）
    deepseek/deepseek-chat  输入 $0.28/M，输出 $0.42/M
……
```

[code/playground/ai-chat.ts](code/playground/ai-chat.ts) 现在用 `--model` 选择模型（用 Node 内置的 `parseArgs` 解析命令行参数）：

```bash
node playground/ai-chat.ts                                       # 默认：假模型服务器，OpenAI 协议
node playground/ai-chat.ts --model fake-anthropic/fake-model     # 同一个假服务器，换成 Anthropic 协议
node --env-file=.env playground/ai-chat.ts --model deepseek/deepseek-chat
```

用假模型服务器分别以两种协议聊几句：**界面上看不出任何区别**。上层代码一行都没改，抽象经受住了考验。

如果你有 DeepSeek 的 key，还可以试试 `deepseek-anthropic/deepseek-chat`：同一个模型，通过 Anthropic 协议访问。

## 7. 接口约定与测试

| 文件 | 新增的导出 |
| --- | --- |
| `src/ai/types.ts` | `Api` 增加 `"anthropic-messages"` 和 `"faux"` |
| `src/ai/http.ts` | `describeHttpError(response)` |
| `src/ai/providers/anthropic.ts` | `streamAnthropic(model, context, options?)`、`convertMessages(context)` |
| `src/ai/providers/faux.ts` | `createFauxModel(steps?, options?)` 返回 `{ model, requests, addReplies, remaining }`；`streamFaux`；类型 `FauxReply`、`FauxStep` |
| `src/ai/models.ts` | `PROVIDERS`、`getProvider(id)`、`getModel(providerId, modelId?)`、`resolveModel(spec)`、`getApiKey(providerId)` |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `anthropic.test.ts`、`faux.test.ts`、`models.test.ts`，测试辅助文件 `test/helpers/fake-server.ts` 现在同时支持两种流式格式。

## 8. 常见错误

| 现象 | 原因 |
| --- | --- |
| Anthropic 返回 400，提示 `max_tokens` | 没有发送 `max_tokens`，它是必填的 |
| Anthropic 返回 401 | 用了 `Authorization: Bearer`，应该用 `x-api-key` |
| Anthropic 返回 400，提示 `anthropic-version` | 漏了版本请求头 |
| Anthropic 返回 400，提示 `temperature` | 新一代 Claude 模型不接受这个参数，去掉它 |
| 404 | Anthropic 兼容接口的 base URL 后面不要再加 `/v1`，适配器会自动加上 `/v1/messages` |
| 测试之间互相干扰 | 多个测试共用了一个假模型的剧本；每个测试应该创建自己的假模型 |

## 9. 练习

1. **加一个服务商**：在 `PROVIDERS` 里加入你常用的服务商或者本地模型（比如你在 Ollama 里下载的模型），用 `ai-chat.ts` 测试它。
2. **聊天中途换模型**：给 `ai-chat.ts` 加一个 `/model 服务商/模型名` 命令，在对话中途切换模型。切换之后，历史里会混着不同服务商生成的消息——它还能正常工作吗？为什么？（提示：想想 `convertMessages` 只取了哪些内容。）
3. **假模型的测试**：为 faux 写一个测试，验证"剧本的一步是函数时，能拿到上一轮模型的回复"。
4. **比较 token 数**：用同一段中文分别问两家服务商，比较它们报告的输入 token 数。为什么会不同？
5. **请求思考摘要**：新一代 Claude 模型默认不返回思考内容的文字（只返回空的思考块和签名）。查阅 Anthropic 的文档，给 `StreamOptions` 增加一个选项，在请求里加上 `thinking: { type: "adaptive", display: "summarized" }`，让模型返回思考摘要。

## 10. 自测问题

1. 为什么说"第二个实现"是检验抽象的最好办法？
2. 系统提示词在两种协议里分别放在哪里？我们的 `Context` 为什么把它单独存放？
3. Anthropic 适配器为什么要用 `Map` 记录 index 和块的对应关系？
4. OpenAI 和 Anthropic 报告输入 token 的方式有什么不同？我们是怎么统一的？
5. 假模型怎么知道该用哪份剧本？
6. 为什么没有列在表里的模型名也应该允许使用？

<details>
<summary>参考答案</summary>

1. 只有一个实现时，很容易把它的特点不知不觉地写进"统一"的接口里。第二个实现能暴露这些问题：如果它很难放进去，说明抽象需要调整。
2. OpenAI：第一条 `system` 消息；Anthropic：请求体的 `system` 字段。单独存放，两种翻译方式都很自然；如果当作一条消息存放，Anthropic 适配器就得把它从消息列表里挑出来。
3. Anthropic 可能发来我们不认识、会跳过的块，跳过之后双方的编号就对不上了。用 `Map` 记录对应关系，并且可以安全地忽略不认识的块。
4. OpenAI 的 `prompt_tokens` 包含缓存命中的部分，Anthropic 的 `input_tokens` 不包含。我们统一让 `usage.input` 表示"没有命中缓存的输入"，OpenAI 适配器要减掉缓存部分。
5. 创建假模型时生成唯一的 id，用模块级的 `Map` 按 id 保存剧本；`streamFaux` 根据 `model.id` 查找。
6. 服务商会不断推出新模型，表格不可能及时更新。用服务商的默认参数，用户就能立刻使用新模型。

</details>

## 11. 对照 pi 源码

- **Anthropic 适配器**：[packages/ai/src/api/anthropic-messages.ts](../../packages/ai/src/api/anthropic-messages.ts)。里程碑 05 已经看过它手写的 SSE 解析器；再往下读，`iterateAnthropicEvents` 只处理它认识的事件类型，然后在 `stream` 函数里按 `content_block_start`、`content_block_delta`、`content_block_stop` 分别处理——和我们的结构一样。pi 额外处理了提示缓存（`cache_control`）、思考预算、图片、工具调用、各种兼容接口的差异。
- **假模型**：[packages/ai/src/providers/faux.ts](../../packages/ai/src/providers/faux.ts)。pi 的 `fauxAssistantMessage`、`fauxText`、`fauxToolCall` 用来构造剧本，`registerFauxProvider` 登记一个假服务商。pi 的整套 coding agent 测试（`packages/coding-agent/test/suite/`）都基于它，不需要任何真实的 API key。
- **服务商定义**：[packages/ai/src/providers/](../../packages/ai/src/providers/) 目录下每个服务商一个文件，比如 `deepseek.ts`、`anthropic.ts`、`moonshotai-cn.ts`，内容就是一个 `createProvider({ id, name, baseUrl, auth, models, api })`——和我们的 `PROVIDERS` 表里的一项一一对应。模型数据（价格、上下文窗口）由脚本从公开的模型目录自动生成，而不是手写。
- **跨服务商的消息转换**：[packages/ai/src/api/transform-messages.ts](../../packages/ai/src/api/transform-messages.ts)。当历史里有其他模型生成的消息时，pi 会判断 `isSameModel`（服务商、协议、模型都相同）：同一个模型的思考块原样保留（带签名），不同模型的思考块转成普通文字或丢弃。mini-pi 采用了更简单、也更保守的策略：之前几轮的思考内容一律不发回，只在下一章的工具循环里发回当前这一轮的。

## 12. 闭卷挑战

不看资料，写出 `streamAnthropic` 中处理事件的 `switch`（文字块、思考块、签名、用量、停止原因、错误事件），让 `test/anthropic.test.ts` 通过。45 分钟内完成即可。

---

上一步：[里程碑 06：统一的消息与事件流](../06-ai-types/README.md) · 下一步：[里程碑 08：工具调用](../08-tools/README.md)
