# 里程碑 04：多轮对话

> 目标：让程序拥有"记忆"，能和模型连续聊天；亲眼看到"无状态"意味着什么、多轮对话的代价是什么。
>
> 完成后你将拥有：`playground/chat.ts`——一个在终端里运行的聊天程序，支持 `/history`、`/reset`、`/exit` 命令，每轮显示 token 用量。

```
$ node --env-file=.env playground/chat.ts
开始聊天吧！模型：deepseek-chat。输入 /help 查看命令，/exit 或 Ctrl+D 退出。
你> 我叫小明，我喜欢打羽毛球
助手> 你好小明！羽毛球是很棒的运动，既锻炼反应又锻炼体力。
（本轮：输入 31、输出 22 tokens；累计：输入 31、输出 22；历史共 3 条消息）
你> 我叫什么？喜欢什么运动？
助手> 你叫小明，喜欢打羽毛球。
（本轮：输入 66、输出 11 tokens；累计：输入 97、输出 33；历史共 5 条消息）
```

## 你将学到

- 为什么 `ask.ts` 记不住你说过的话
- 用一个消息数组保存对话历史
- 用 `readline` 一行一行读取用户输入
- 保持历史"结构合法"：请求失败时要撤回
- 多轮对话的成本为什么会越来越高——以及这和"上下文窗口"有什么关系

---

## 1. 问题：模型记不住

用上一章的 `ask.ts` 做个实验（用真实模型）：

```bash
node --env-file=.env playground/ask.ts "我叫小明"
node --env-file=.env playground/ask.ts "我叫什么名字？"
```

第二次，模型会说它不知道你叫什么。

这就是上一章强调的：**大模型是无状态的**。第二个请求里只有"我叫什么名字？"这一句话，模型怎么可能知道答案？

## 2. 解决：每次都发送完整的历史

既然模型不记事，那就由**我们的程序**来记。程序维护一个消息数组，每次：

1. 把用户的新消息追加到数组末尾；
2. 把**整个数组**发给模型；
3. 把模型的回答也追加到数组末尾。

```
第 1 轮发送：[system, user:"我叫小明"]
         收到：assistant:"你好小明！"
第 2 轮发送：[system, user:"我叫小明", assistant:"你好小明！", user:"我叫什么名字？"]
         收到：assistant:"你叫小明。"
第 3 轮发送：[system, user, assistant, user, assistant, user:"……"]
```

模型并没有"记住"任何东西，它只是每次都把整段对话重新读了一遍。你看到的"记忆"，完全是程序制造出来的。

> 这是理解所有聊天机器人、包括 coding agent 的关键。pi 里的"会话"、"上下文"、"压缩"，归根到底都是在管理**这个数组**。

用假模型服务器可以直观地验证这一点。它的回复会告诉你"本次请求共包含 N 条消息"。第一轮是 1 条，第二轮是 3 条，第三轮是 5 条——历史在不断增长。

## 3. 读取用户输入：readline

要做聊天程序，得能读取用户在终端里输入的一行行文字。Node 内置的 `node:readline` 模块就是干这个的：

```ts
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt("你> ");
rl.prompt();

for await (const line of rl) {
	console.log(`你输入了：${line}`);
	rl.prompt();
}
console.log("再见！");
```

- `process.stdin` 是**标准输入**，也就是键盘输入（或者通过管道传进来的数据）；`process.stdout` 是标准输出。
- `rl.prompt()` 打印提示符 `你> `，等待用户输入。
- `for await (const line of rl)`：每当用户输入一行并按回车，循环就拿到这一行。是不是很眼熟？`rl` 就是一个**异步可迭代对象**，和里程碑 02 的异步生成器是同一个概念。
- 用户按 **Ctrl+D**（表示"输入结束"）或者程序调用 `rl.close()` 时，循环结束。

还有一个细节：在 readline 里按 **Ctrl+C**，默认只会"暂停"输入，而不是退出。所以我们加上：

```ts
rl.on("SIGINT", () => rl.close());
```

这样 Ctrl+C 也能退出。

## 4. 动手：写 chat.ts

### 4.1 类型和配置

```ts
interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

interface ChatCompletionResponse {
	choices: { message: { content: string | null }; finish_reason: string }[];
	usage?: Usage;
}
```

读取 `LLM_BASE_URL` 等三个环境变量的代码和上一章一样。

### 4.2 历史数组

```ts
const systemPrompt = process.env.LLM_SYSTEM ?? "你是一个乐于助人的助手。回答要简洁。";

/** 对话历史。第一条永远是系统提示词。 */
const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
let totalInput = 0;
let totalOutput = 0;
```

系统提示词放在第一条，每次请求都会带上它。

### 4.3 调用模型的函数

把上一章的请求代码整理成一个函数。和 `ask.ts` 不同的是，出错时**抛出异常**而不是直接退出程序——聊天程序不应该因为一次请求失败就整个退出：

```ts
async function complete(history: ChatMessage[]): Promise<{ text: string; usage?: Usage }> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, messages: history }),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}：${await response.text()}`);
	}
	const data = (await response.json()) as ChatCompletionResponse;
	const choice = data.choices?.[0];
	if (!choice) throw new Error(`响应里没有 choices：${JSON.stringify(data)}`);
	return { text: choice.message.content ?? "", usage: data.usage };
}
```

### 4.4 主循环

```ts
for await (const rawLine of rl) {
	const line = rawLine.trim();
	if (line === "") {
		rl.prompt();
		continue;
	}
	if (line.startsWith("/")) {
		handleCommand(line);
		if (line !== "/exit") rl.prompt();
		continue;
	}

	messages.push({ role: "user", content: line });
	try {
		const { text, usage } = await complete(messages);
		messages.push({ role: "assistant", content: text });
		console.log(`助手> ${text}`);
		// ……打印用量……
	} catch (error) {
		messages.pop();
		console.error(`出错了：${error instanceof Error ? error.message : String(error)}`);
	}
	rl.prompt();
}
```

`trim()` 去掉首尾的空格和换行，空行直接忽略。

### 4.5 失败时为什么要撤回（messages.pop）

**问题**：用户发了一句话，我们先把它加进了历史，然后请求失败了（比如网络断了）。如果不撤回，历史会变成：

```
[system, user:"第一句", assistant:"……", user:"失败的那句"]
```

用户再说一句话，历史变成两条 `user` 消息挨在一起：

```
[system, user:"第一句", assistant:"……", user:"失败的那句", user:"新的一句"]
```

有的服务商会直接拒绝这种请求（要求 user 和 assistant 交替出现）；即使不拒绝，模型也会对着一个"没有得到回答的问题"困惑。

**解决**：请求失败时把刚加入的用户消息删掉，让历史回到"一问一答"交替的合法状态。

这体现了一个贯穿整门课的原则：**历史是程序最重要的状态，任何时候都要保持它合法。** 到了 agent 阶段，规则会更严格：每一个工具调用后面都必须紧跟它的结果，否则服务商会报错。

### 4.6 命令

```ts
function handleCommand(command: string): void {
	switch (command) {
		case "/help":
			console.log("可用命令：/history 查看历史，/reset 清空历史，/exit 退出");
			break;
		case "/history":
			for (const [index, message] of messages.entries()) {
				const preview = message.content.length > 40 ? `${message.content.slice(0, 40)}…` : message.content;
				console.log(dim(`${index}. [${message.role}] ${preview}`));
			}
			break;
		case "/reset":
			messages.length = 1; // 只保留第一条：系统提示词
			totalInput = 0;
			totalOutput = 0;
			console.log(dim("（历史已清空，模型将不记得之前的对话）"));
			break;
		case "/exit":
			rl.close();
			break;
		default:
			console.log(`不认识的命令：${command}，输入 /help 查看可用命令`);
	}
}
```

- `messages.entries()` 同时给出下标和元素。
- `messages.length = 1` 是一个截断数组的小技巧：把长度设为 1，后面的元素就都没了。
- `dim()` 是一个让文字变成灰色的小函数：`` `\x1b[2m${text}\x1b[0m` ``。`\x1b[2m` 和 `\x1b[0m` 是 **ANSI 转义码**，终端看到它们不会显示出来，而是改变文字样式。里程碑 16 会详细讲，现在知道怎么用就行。

pi 里也有类似的命令：`/new` 开始新会话，`/compact` 压缩历史，`/tree` 查看会话树……都是以 `/` 开头的**斜杠命令**。

完整代码：[code/playground/chat.ts](code/playground/chat.ts)。

## 5. 运行

```bash
node --env-file=.env playground/chat.ts
```

先用假模型服务器跑一遍，注意观察每轮"本次请求共包含 N 条消息"的变化。然后换成真实模型，测试它是否记得你前面说的话。再试试 `/reset` 之后问它"我叫什么"。

也可以用管道一次性喂入多行输入，这在测试时很方便：

```bash
printf "我叫小明\n我叫什么？\n/exit\n" | node --env-file=.env playground/chat.ts
```

（`printf` 打印字符串，`\n` 是换行；`|` 把左边命令的输出接到右边命令的标准输入。）

## 6. 多轮对话的代价

用假模型服务器跑几轮，你会看到类似的数字：

| 轮次 | 本轮输入 tokens | 累计输入 tokens |
| --- | --- | --- |
| 1 | 21 | 21 |
| 2 | 70 | 91 |
| 3 | 123 | 214 |

每一轮都要把之前所有的消息再发一遍，所以：

- **每轮的输入**随轮数线性增长；
- **累计的输入**（也就是你付的钱）增长得更快，大约和轮数的平方成正比。

更要命的是**上下文窗口**：历史迟早会超过模型能处理的上限，请求直接失败。

对于聊天机器人，这个问题还不算严重。但 coding agent 动不动就读几个大文件、运行输出很长的命令，历史增长得飞快，可能几轮之后就到了上限。怎么办？有几种思路：

1. **滑动窗口**：只发送最近 N 条消息。简单，但会忘掉早期的重要信息（比如用户一开始说的需求）。
2. **截断工具输出**：读文件、执行命令时，只返回前（或后）若干行（里程碑 11、12）。
3. **压缩（compaction）**：让模型把早期的对话总结成一段摘要，用摘要替换原文（里程碑 15，pi 用的就是这种方式）。
4. **提示缓存（prompt caching）**：很多服务商会缓存"和上次请求开头相同的部分"，缓存命中的 token 价格便宜得多。这也是为什么 agent 总是"在末尾追加"消息，而不是修改前面的消息——修改前面会让缓存失效。

练习 4 会让你亲手实现滑动窗口，体会它的缺点。

## 7. 接口约定与自动检查

- 文件：`playground/chat.ts`
- 配置：同里程碑 03，从 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 读取。
- 输入：从标准输入逐行读取。空行忽略；`/reset` 清空历史（保留系统提示词）；`/exit` 退出；输入结束（Ctrl+D）时退出。退出码为 0。
- 请求：第一条消息是 `system`；之后按顺序包含所有历史消息。
- 输出：打印模型的回答。
- 出错：打印错误（包含 HTTP 状态码），撤回那条用户消息，继续等待输入。

```bash
node --test learn/04-chat/check.test.ts                      # 检查参考答案
MY_PI=~/my-pi node --test learn/04-chat/check.test.ts        # 检查你的项目
```

## 8. 常见错误

| 现象 | 原因 |
| --- | --- |
| 模型还是记不住 | 发送的是只有一条消息的新数组，而不是 `messages`；或者忘了把模型的回答 `push` 进历史 |
| 回答被重复打印 | 在两个地方都打印了 |
| 按 Ctrl+C 程序没反应 | 没有处理 readline 的 `SIGINT` 事件 |
| 程序在请求失败后退出了 | 在 `complete` 里用了 `process.exit`，而不是抛出异常 |
| 第二次请求报 400，说消息格式不对 | 请求失败后没有撤回用户消息，导致两条 user 消息相邻 |

## 9. 练习

1. **/undo**：撤销最近一轮对话（删除最后一条 user 消息以及它之后的所有消息）。
2. **/save 和 /load**：`/save chat.json` 把历史保存成 JSON 文件，`/load chat.json` 载入。关掉程序再打开，载入后模型还"记得"之前的对话吗？（这就是里程碑 14"会话持久化"的雏形。）
3. **/system**：`/system 你是一只猫` 修改系统提示词（替换 `messages[0]`），观察模型的变化。
4. **滑动窗口**：环境变量 `MAX_HISTORY=4` 时，只发送系统提示词和最近 4 条消息。聊十轮，问问模型你最开始说了什么。注意：截取后如果第一条是 assistant 消息，要把它也去掉（有的服务商要求对话以 user 开头）。
5. **费用统计**：结合里程碑 03 的练习，在每轮后显示累计花费。

练习 1、2、4 的参考答案：[solutions/chat-plus.ts](solutions/chat-plus.ts)。

## 10. 自测问题

1. 模型"记得"之前的对话，是因为它把对话存在服务器上了吗？
2. 第 10 轮对话时，请求里大约有多少条消息？
3. 为什么请求失败时要把用户消息撤回？
4. 为什么多轮对话的累计成本增长得比轮数快？
5. 滑动窗口有什么缺点？

<details>
<summary>参考答案</summary>

1. 不是。是我们的程序每次都把完整的历史发过去，模型每次都重新读一遍。
2. 1 条系统提示词 + 9 轮完整的问答（18 条）+ 第 10 轮的问题（1 条）= 20 条。
3. 保持历史结构合法：user 和 assistant 交替出现。否则可能被服务商拒绝，或者让模型困惑。
4. 每轮都要重发之前所有的消息，第 n 轮的输入量大约和 n 成正比，n 轮加起来大约和 n² 成正比。
5. 会丢掉早期的信息，而早期往往包含最重要的内容，比如用户最初的需求和约束。

</details>

## 11. 对照 pi 源码

- pi 的 Agent 把历史保存在 `agent.state.messages` 里（[packages/agent/src/agent.ts](../../packages/agent/src/agent.ts)）。每次请求时，agent loop 会把整个 `context.messages` 交给模型（[packages/agent/src/agent-loop.ts](../../packages/agent/src/agent-loop.ts) 里的 `streamAssistantResponse`）。和我们的 `messages` 数组是同一个思路。
- pi 的 `Agent.reset()` 方法：
  ```ts
  reset(): void {
  	// ……
  	const baseline = getCurrentSystemMessage(this._state.messages);
  	this._state.messages = baseline ? [baseline] : [];
  	// ……
  }
  ```
  清空历史但保留系统提示词——和我们的 `/reset` 一模一样。
- pi 的斜杠命令定义在 [packages/coding-agent/src/core/slash-commands.ts](../../packages/coding-agent/src/core/slash-commands.ts)。
- pi 的压缩机制的文档：[packages/coding-agent/docs/compaction.md](../../packages/coding-agent/docs/compaction.md)。第 6 节说的问题，就是它要解决的。

## 12. 闭卷挑战

不看资料写出 `chat.ts`：readline 循环、历史数组、调用函数、失败撤回、`/reset` 和 `/exit`。用检查脚本验证。20 分钟内完成即可进入下一章。

---

上一步：[里程碑 03：第一次调用大模型](../03-first-call/README.md) · 下一步：[里程碑 05：流式输出](../05-streaming/README.md)
