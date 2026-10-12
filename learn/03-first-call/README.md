# 里程碑 03：第一次调用大模型

> 目标：理解大模型 API 是什么，拿到一个 API key，用 `fetch` 亲手发出第一个请求。
>
> 完成后你将拥有：`playground/ask.ts`——在命令行里问大模型一个问题，打印回答和 token 用量。

```
$ node --env-file=.env playground/ask.ts "天空为什么是蓝色的？"
因为太阳光穿过大气层时，波长较短的蓝光被空气分子散射得最厉害（瑞利散射），
所以我们从各个方向看到的天空都是蓝色的。

（模型：deepseek-chat，输入 24 tokens，输出 53 tokens，用时 1.8 秒，停止原因：stop）
```

## 你将学到

- 大模型 API 的本质：一个"消息进、消息出"的无状态函数
- token 是什么，大模型怎么收费
- 怎么选择服务商、获取 API key，以及怎么安全地保管它
- 环境变量和 `.env` 文件
- OpenAI Chat Completions 接口的请求和响应格式
- 用 curl 和 fetch 发请求，处理各种错误

---

## 1. 大模型 API 是什么

你在网页上和 ChatGPT、DeepSeek 聊天时，背后发生的事情是：网页把你的消息通过 HTTP 发给服务器，服务器上的大模型生成回答，再通过 HTTP 发回来。

**API**（Application Programming Interface，应用程序接口）就是服务商开放给**程序**使用的那个入口。你的程序可以像网页一样发请求、拿回答，从而把大模型的能力用在自己的程序里。coding agent 就是这样一个程序。

从程序的角度看，调用大模型就像调用一个函数：

```
输入：一组消息（对话历史）
  [ { role: "system", content: "你是一个乐于助人的助手。" },
    { role: "user",   content: "天空为什么是蓝色的？" } ]
            │
            ▼  HTTP POST
      ┌──────────────┐
      │  大模型服务   │
      └──────────────┘
            │
            ▼
输出：一条新消息
  { role: "assistant", content: "因为太阳光穿过大气层时……" }
```

消息有三种角色（role）：

| 角色 | 含义 |
| --- | --- |
| `system` | **系统提示词**：给模型的"幕后指示"，设定它的身份、规则、说话风格。用户看不到它，但模型会认真遵守。 |
| `user` | 用户说的话 |
| `assistant` | 模型说的话 |

一个非常重要的事实，请牢牢记住：**大模型是无状态的。** 它不会"记得"你上次问了什么。每次请求都是独立的，你发给它什么，它就只知道什么。想要多轮对话，必须每次都把完整的历史发过去——这是下一个里程碑的主题。

## 2. token：大模型的计量单位

大模型并不是一个字一个字地读文本，而是把文本切成一个个 **token**（词元）。一个 token 可能是一个英文单词、半个单词、一个汉字或者半个汉字，取决于模型的"分词器"。粗略地说：

- 英文：1 个 token 约等于 4 个字母，或者 0.75 个单词。
- 中文：1 个汉字约等于 1~1.5 个 token（不同模型差别不小）。

token 决定了两件重要的事：

1. **价格**。服务商按 token 收费，输入（你发过去的）和输出（模型生成的）分开计价，通常以"每百万 token 多少钱"标价。输出一般比输入贵好几倍。
2. **上下文窗口（context window）**。每个模型一次能处理的 token 总数有上限，比如 128K（约 12.8 万）token。超过了就会报错。对于要读很多文件的 coding agent，这个限制非常关键（里程碑 15 专门解决它）。

每次调用后，API 都会告诉你这次用了多少 token，我们会把它打印出来。

## 3. 选择服务商，获取 API key

**API key** 是一串类似 `sk-a1b2c3...` 的密钥，它代表你的账户。拿着它就能以你的名义调用 API、花你的钱。

> **保管好你的 key**：不要发给别人，不要截图发到群里，**绝对不要提交到 git 或上传到 GitHub**（有机器人专门扫描 GitHub 上泄露的 key 并盗刷）。如果不小心泄露了，立刻去服务商后台删除它，重新生成一个。

下面这些服务都兼容 **OpenAI Chat Completions** 接口格式，所以我们写一份代码就能用于所有服务商，只需要换三个配置：**地址（base URL）**、**key**、**模型名**。

| 服务商 | base URL | 模型名举例 | 说明 |
| --- | --- | --- | --- |
| 课程的假模型服务器 | `http://localhost:4000/v1` | 任意 | 不花钱、不联网，先用它把程序跑通 |
| [DeepSeek](https://platform.deepseek.com/) | `https://api.deepseek.com` | `deepseek-chat` | 国内可直接访问，价格便宜，工具调用能力好 |
| [阿里云百炼（通义千问）](https://bailian.console.aliyun.com/) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 新用户通常有免费额度 |
| [Moonshot（Kimi）](https://platform.moonshot.cn/) | `https://api.moonshot.cn/v1` | 见官网模型列表 | |
| [智谱](https://open.bigmodel.cn/) | `https://open.bigmodel.cn/api/paas/v4` | 见官网模型列表 | 提供免费的 Flash 系列模型 |
| [硅基流动](https://siliconflow.cn/) | `https://api.siliconflow.cn/v1` | 见官网模型列表 | 聚合了很多开源模型，部分免费 |
| [Ollama](https://ollama.com/)（本地） | `http://localhost:11434/v1` | 如 `qwen3:8b` | 在你自己电脑上运行开源模型，完全免费，但需要较好的电脑；key 随便填 |
| [OpenRouter](https://openrouter.ai/) | `https://openrouter.ai/api/v1` | 如 `openai/gpt-4o-mini` | 一个 key 用几百个模型 |
| [OpenAI](https://platform.openai.com/) | `https://api.openai.com/v1` | 如 `gpt-4o-mini` | |

> 模型名经常更新，**请以服务商官网的文档为准**。注册账户、充值少量金额（几元钱足够用很久）、在控制台里创建 API key，就可以开始了。

**建议**：先用假模型服务器完成本章，确认程序没问题后，再换成真实的服务商。这样遇到问题时，你能分清是代码的问题还是账户/网络的问题。

## 4. 环境变量和 .env 文件

**问题**：key 写在哪里？直接写在代码里（`const apiKey = "sk-xxx"`）是最糟糕的做法：一提交到 git 就泄露了，而且换个模型就得改代码。

**解决**：通过**环境变量**把配置传给程序。环境变量是操作系统给每个程序的一组"名字=值"的配置，程序里用 `process.env.名字` 读取。

方法一，在命令前面临时设置（只对这一条命令有效）：

```bash
LLM_BASE_URL=http://localhost:4000/v1 LLM_API_KEY=fake LLM_MODEL=fake-model node playground/ask.ts "你好"
```

方法二（推荐），写进 `.env` 文件，运行时让 Node 读取它。在 `my-pi` 目录新建 `.env`：

```bash
LLM_BASE_URL=http://localhost:4000/v1
LLM_API_KEY=fake
LLM_MODEL=fake-model
```

运行时加上 `--env-file=.env`：

```bash
node --env-file=.env playground/ask.ts "你好"
```

确认 `.gitignore` 里有 `.env`（里程碑 00 已经加过了）。好的习惯是再提交一个不含真实 key 的 `.env.example` 作为模板，告诉别人需要哪些配置（见 [code/.env.example](code/.env.example)）。

> 我们约定使用 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 这三个名字。里程碑 07 之后，mini-pi 会像 pi 一样，按服务商使用各自的变量名，比如 `DEEPSEEK_API_KEY`。

## 5. 请求长什么样

OpenAI Chat Completions 接口的请求：

```http
POST {base URL}/chat/completions
Content-Type: application/json
Authorization: Bearer {API key}

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "你是一个乐于助人的助手。回答要简洁。" },
    { "role": "user", "content": "天空为什么是蓝色的？" }
  ]
}
```

- **方法**是 `POST`，**地址**是 base URL 后面加 `/chat/completions`。
- `Content-Type: application/json` 告诉服务器"请求体是 JSON"。
- `Authorization: Bearer xxx` 是身份认证。`Bearer`（持有者）是一种认证方式的名字，意思是"持有这个 token 的人就有权限"，后面跟一个空格再跟 key。
- 请求体里，`model` 和 `messages` 是必需的。可选参数还有很多，常用的有：
  - `max_tokens`：最多生成多少个 token。
  - `temperature`：随机性，0~2 之间。越低越稳定、越"死板"，越高越有创造性。写代码一般用较低的值。

### 先用 curl 试一试

`curl` 是一个命令行的 HTTP 工具，macOS 和 Linux 都自带。在写代码之前，先用它直接发一个请求，看看最原始的样子。启动假模型服务器后运行：

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fake" \
  -d '{"model":"fake-model","messages":[{"role":"user","content":"你好"}]}'
```

（行末的 `\` 表示命令还没写完，下一行接着写。）

你会看到服务器返回的 JSON：

```json
{"id":"chatcmpl_k3j2h1","object":"chat.completion","created":1760000000,"model":"fake-model","choices":[{"index":0,"message":{"role":"assistant","content":"你说的是：「你好」。我是假模型，只会复读。（本次请求共包含 1 条消息）"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":36,"total_tokens":38}}
```

就这么简单。所谓"调用大模型 API"，本质上就是发这样一个 HTTP 请求。

## 6. 响应长什么样

把上面的响应整理一下：

```json
{
  "id": "chatcmpl_k3j2h1",
  "model": "fake-model",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你说的是：……" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 2, "completion_tokens": 36, "total_tokens": 38 }
}
```

- `choices`：一个数组，因为接口允许一次生成多个候选回答（我们只用第一个，`choices[0]`）。
- `message`：模型的回复，就是一条 `assistant` 消息。注意 `content` 可能是 `null`（以后模型只调用工具、不说话时就会这样）。
- `finish_reason`：模型为什么停下来。
  - `stop`：说完了，正常结束。
  - `length`：达到了 `max_tokens` 上限，话被截断了。
  - `tool_calls`：模型想调用工具（里程碑 08）。
- `usage`：token 用量。`prompt_tokens` 是输入，`completion_tokens` 是输出。

## 7. 动手：写 ask.ts

现在用代码做同样的事。新建 `playground/ask.ts`，一段一段地写。

### 7.1 描述响应的类型

```ts
interface ChatCompletionResponse {
	model: string;
	choices: {
		message: { role: string; content: string | null };
		finish_reason: string;
	}[];
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
```

只描述我们要用到的字段就行。`usage?` 加问号，是因为不是所有服务都保证返回它。

### 7.2 读取配置和问题

```ts
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请先设置环境变量 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可以写在 .env 文件里，见 README）");
	process.exit(1);
}

const question = process.argv.slice(2).join(" ");
if (!question) {
	console.error('用法：node --env-file=.env playground/ask.ts "你的问题"');
	process.exit(1);
}
```

- `console.error` 和 `console.log` 一样会打印，但输出到"标准错误"（stderr）而不是"标准输出"（stdout）。错误信息应该用它。区别在于：用户把输出重定向到文件时（`node ask.ts "..." > answer.txt`），错误信息仍然会显示在屏幕上，不会混进文件里。
- `process.exit(1)` 立刻结束程序。**退出码** 0 表示成功，非 0 表示失败。其他程序（比如测试脚本）靠退出码判断你的程序是否成功。
- `process.argv.slice(2).join(" ")`：允许用户不加引号输入多个词，比如 `ask.ts 你好 世界`。

### 7.3 发送请求

```ts
const startedAt = Date.now();
let response: Response;
try {
	response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: "你是一个乐于助人的助手。回答要简洁。" },
				{ role: "user", content: question },
			],
		}),
	});
} catch (error) {
	console.error(`连不上 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
```

`fetch` 的第二个参数描述请求：方法、请求头、请求体。请求体必须是字符串，所以用 `JSON.stringify` 把对象转成 JSON 文本。

`let response: Response;` 先声明、后在 `try` 里赋值。为什么 tsc 不抱怨 `catch` 分支里没赋值？因为 `process.exit()` 的返回类型是 `never`（"永远不会返回"），tsc 知道走到 `catch` 的话程序就结束了。

### 7.4 检查状态码，解析响应

```ts
if (!response.ok) {
	console.error(`请求失败：HTTP ${response.status}`);
	console.error(await response.text());
	process.exit(1);
}

const data = (await response.json()) as ChatCompletionResponse;
const choice = data.choices?.[0];
if (!choice) {
	console.error("响应里没有 choices：", JSON.stringify(data));
	process.exit(1);
}
console.log(choice.message.content ?? "（模型没有返回文字）");
```

记得里程碑 02 讲的坑吗：**`fetch` 不会因为 401、500 这样的错误状态码抛异常**，必须自己检查 `response.ok`。出错时把响应体打印出来，服务商一般会在里面说明原因。

这里用 `as ChatCompletionResponse` 告诉 tsc"相信我，数据是这个形状"。严格来说，按里程碑 01 的原则，网络数据应该当成 `unknown` 逐层检查。在这个小脚本里，我们用 `?.` 做了最关键的防护（`choices` 不存在时不会崩溃）。到了里程碑 06，我们会写更严谨的解析代码。

### 7.5 打印用量

```ts
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const usage = data.usage;
const usageText = usage ? `输入 ${usage.prompt_tokens} tokens，输出 ${usage.completion_tokens} tokens` : "没有返回用量";
console.log(`\n（模型：${data.model}，${usageText}，用时 ${seconds} 秒，停止原因：${choice.finish_reason}）`);
```

完整代码：[code/playground/ask.ts](code/playground/ask.ts)。

## 8. 运行

### 8.1 用假模型服务器

终端一：

```bash
node ~/pi/learn/tools/fake-llm/server.ts
```

终端二（在 `my-pi` 目录，`.env` 里配置的是假模型服务器）：

```bash
node --env-file=.env playground/ask.ts "天空为什么是蓝色的？"
```

```
你说的是：「天空为什么是蓝色的？」。我是假模型，只会复读。（本次请求共包含 1 条消息，以及一段系统提示词）

（模型：fake-model，输入 29 tokens，输出 53 tokens，用时 0.1 秒，停止原因：stop）
```

同时看看终端一，假模型服务器打印了它收到的请求。加上 `--verbose` 启动服务器，还能看到完整的请求 JSON。

### 8.2 用真实的模型

把 `.env` 改成你选择的服务商的配置，例如：

```bash
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-你的key
LLM_MODEL=deepseek-chat
```

再运行一次。恭喜你，你的程序第一次和真正的大模型对话了！

## 9. 常见错误

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `请先设置环境变量……` | 没有加 `--env-file=.env`，或者 `.env` 里的名字拼错了 | 检查命令和 `.env` |
| `node: .env: not found` | 当前目录下没有 `.env` 文件 | `cd` 到 `my-pi` 目录，或者先创建 `.env` |
| `连不上 ……：fetch failed` | 地址写错、没联网、假模型服务器没启动、需要代理 | 用浏览器或 curl 访问一下那个地址 |
| `HTTP 401` | key 不对、过期了、或者多了空格 | 重新复制 key，检查 `Bearer ` 后面有没有空格 |
| `HTTP 404` | base URL 不对，比如少了或多了 `/v1` | 对照服务商文档检查地址 |
| `HTTP 400`，提示 model 不存在 | 模型名写错了 | 去服务商文档复制准确的模型名 |
| `HTTP 402` 或提示余额不足 | 账户没钱了 | 充值 |
| `HTTP 429` | 请求太频繁，或者额度用完 | 等一会儿再试（里程碑 19 会实现自动重试） |
| `停止原因：length` | 回答被 `max_tokens` 截断了 | 调大 `max_tokens` 或者不设置 |

## 10. 接口约定与自动检查

为了让课程提供的检查脚本能检查**你自己的代码**，请遵守下面的约定：

- 文件：`playground/ask.ts`
- 配置：从环境变量 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 读取；缺少时打印包含 `LLM_` 的提示，退出码非 0。
- 输入：命令行参数用空格连起来作为问题；没有参数时提示用法，退出码非 0。
- 请求：`POST ${LLM_BASE_URL}/chat/completions`，带 `Authorization: Bearer ${LLM_API_KEY}`。
- 输出：打印模型的回答；打印包含 `tokens` 字样的用量信息。
- HTTP 错误：打印状态码，退出码非 0。

运行检查（在课程仓库的根目录）：

```bash
# 检查参考答案（应该全部通过）
node --test learn/03-first-call/check.test.ts

# 检查你自己的项目
MY_PI=~/my-pi node --test learn/03-first-call/check.test.ts
```

检查脚本会自己启动一个假模型服务器，所以不需要你提前启动。看到 `# fail 0` 就是全部通过了。如果有失败的项，错误信息会告诉你哪一条约定没满足。

## 11. 练习

1. **可配置的系统提示词**：如果设置了环境变量 `LLM_SYSTEM`，就用它作为系统提示词，否则用默认的。试试 `LLM_SYSTEM="你是一个只会用文言文回答的老学究"`。
2. **翻译器**：写 `playground/translate.ts`，把参数翻译成英文，只输出译文。提示：只需要改系统提示词，再把 `temperature` 设为 0。参考答案：[solutions/translate.ts](solutions/translate.ts)。
3. **算算花了多少钱**：从环境变量 `LLM_PRICE_INPUT`、`LLM_PRICE_OUTPUT` 读取每百万 token 的价格，打印这次调用的花费。参考答案：[solutions/ask-cost.ts](solutions/ask-cost.ts)。
4. **温度实验**：用真实模型，同一个问题（比如"给我的猫起个名字"）分别用 `temperature` 0 和 1.5 各问三次，比较回答的差异。
5. **截断实验**：设置 `max_tokens: 20`，问一个需要长回答的问题，观察回答和 `finish_reason`。
6. **用 curl 调用真实模型**：把第 5 节的 curl 命令改成你的服务商地址和 key。

## 12. 自测问题

1. 为什么说大模型是"无状态"的？这对写聊天程序意味着什么？
2. 输入 token 和输出 token 哪个通常更贵？
3. 为什么不能把 API key 写在代码里？
4. `fetch` 返回 401 时会抛异常吗？
5. `finish_reason` 为 `length` 说明了什么？
6. 为什么错误信息要用 `console.error` 而不是 `console.log`？

<details>
<summary>参考答案</summary>

1. 每次请求都是独立的，模型只知道这次请求里的消息。聊天程序必须自己保存历史，每次把完整历史发过去。
2. 输出通常更贵，往往是输入的几倍。
3. 代码会被提交到 git、分享给别人，key 会泄露；而且换配置要改代码。
4. 不会，要自己检查 `response.ok` 或 `response.status`。
5. 模型的输出达到了 `max_tokens` 上限，被截断了，回答不完整。
6. 错误信息输出到 stderr，用户重定向 stdout 时，错误不会混进结果里，并且仍然能在屏幕上看到。

</details>

## 13. 对照 pi 源码

- pi 的 OpenAI 兼容适配器在 [packages/ai/src/api/openai-completions.ts](../../packages/ai/src/api/openai-completions.ts)。它用的是 OpenAI 官方 SDK（`client.chat.completions.create(...)`），但 SDK 最终发出的就是我们手写的这个 HTTP 请求。搜索 `function buildParams`，你会看到它在组装 `model`、`messages`、`max_tokens`、`temperature` 等字段。
- pi 为每家服务商定义了 base URL，比如 [packages/ai/src/providers/deepseek.ts](../../packages/ai/src/providers/deepseek.ts)：
  ```ts
  return createProvider({
  	id: "deepseek",
  	name: "DeepSeek",
  	baseUrl: "https://api.deepseek.com",
  	auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  	models: Object.values(DEEPSEEK_MODELS),
  	api: openAICompletionsApi(),
  });
  ```
  注意 `api: openAICompletionsApi()`：DeepSeek 复用了 OpenAI 兼容的实现，正如我们的 `ask.ts` 可以用于所有兼容的服务商。
- 服务商和环境变量的对应关系在 [packages/ai/src/env-api-keys.ts](../../packages/ai/src/env-api-keys.ts) 里，比如 `deepseek: "DEEPSEEK_API_KEY"`、`moonshotai-cn: "MOONSHOT_API_KEY"`。
- pi 的 `.gitignore` 里同样有 `.env`。

## 14. 闭卷挑战

不看任何资料，写出 `ask.ts`：读取三个环境变量、发送请求、检查状态码、打印回答和用量。写完后用检查脚本验证。15 分钟以内完成即可进入下一章。

---

上一步：[里程碑 02：异步编程与流](../02-async/README.md) · 下一步：[里程碑 04：多轮对话](../04-chat/README.md)
