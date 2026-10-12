# 里程碑 15：上下文压缩

> 目标：对话快要超出模型的上下文窗口时，自动让模型把旧的部分写成一份结构化的总结，只保留最近的消息原文。这样 agent 可以连续工作几个小时，而不会因为"装不下"而罢工。
>
> 完成后你将拥有：`src/core/compaction.ts`、会自动压缩的 `AgentSession`、`/compact` 命令，以及用来做实验的 `--context-window` 参数。

```
$ mini-pi --context-window 8000
你> 读取 numbers.txt
> read numbers.txt
……
你> 读取 numbers.txt
……
你> 读取 numbers.txt
（上下文快满了，正在压缩……）（压缩完成：总结了 8 条消息，上下文从约 8191 降到约 3520 tokens）
> read numbers.txt
……
```

## 你将学到

- 上下文窗口：为什么对话会"装不下"
- 估算 token：服务商报告的用量，加上按字符数的估算；汉字和英文的区别
- 什么时候压缩、切在哪里（绝不拆开工具调用和它的结果）
- 怎样写总结的提示词：一份结构化的"检查点"
- 压缩记录怎样保存在会话里、怎样恢复
- 在 agent 循环的两轮之间插入一个钩子

---

## 1. 问题：上下文窗口装满了

每个模型都有一个**上下文窗口**：一次请求里，输入和输出加起来最多能有多少 token。常见的是 128K（12.8 万）到 1M。听起来很多，但 coding agent 消耗得很快：

- 每次 `read` 最多返回 50KB，一个大文件就是一万多个 token（中文更多）；
- 每次请求都要把**整个对话**重新发一遍；
- 一个两三个小时的任务，读几十个文件、跑几十次测试，很平常。

超出窗口时，服务商直接拒绝请求：

```
400 This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.
```

agent 就卡住了：每次请求都带着同样多的历史，每次都失败。

即使没超出，长对话也很贵：第 100 次请求要把前面 99 次的内容全部再发一遍（缓存能省一部分，但不是全部）。

## 2. 几种办法

| 办法 | 问题 |
| --- | --- |
| 删掉最旧的消息 | 最旧的消息里往往是任务的目标和最初的要求，删掉之后模型就不知道自己在干什么了 |
| 只删掉旧的工具结果的内容 | 能省一些，但对话本身也会越来越长；而且模型会忘记它读到过什么 |
| **压缩**：让模型把旧的部分写成一份总结，最近的消息保留原文 | 多一次模型调用（要花一点时间和钱），总结也会丢失一些细节 |

pi、Claude Code 等主流 agent 都用压缩。关键是让总结保留**继续工作需要的信息**：目标是什么、做到了哪一步、做过哪些决定、下一步是什么、改过哪些文件。

## 3. 估算 token

要决定什么时候压缩，先得知道现在的上下文有多大。

### 3.1 服务商报告的数字最准

每条回复都带着服务商报告的用量（里程碑 06）：`usage.totalTokens` 就是这次请求的输入加输出。所以最准确的估计是：**最后一条正常完成的回复的 `totalTokens`，加上它之后的消息的估算**（比如刚执行完的工具结果、新的问题，它们还没有发给模型）。

[code/src/core/compaction.ts](code/src/core/compaction.ts)：

```ts
export function estimateContextTokens(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage.totalTokens > 0) {
			let trailing = 0;
			for (const later of messages.slice(i + 1)) trailing += estimateTokens(later);
			return message.usage.totalTokens + trailing;
		}
	}
	// 还没有任何用量数据：全部估算
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

出错或被取消的回复没有可靠的用量数据，要跳过。

### 3.2 按字符数估算

没有用量数据的消息，只能估算。精确的 token 数取决于模型用的**分词器**（把文字切成 token 的方法），每家都不一样。我们用一个简单的经验公式：

```ts
export function estimateTextTokens(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}
```

- **英文和代码**：大约 4 个字符一个 token。
- **汉字**（以及日文、韩文）：大约一个字一个 token。

pi 只用"字符数 ÷ 4"，因为它的用户主要写英文。但"你好世界"按 ÷ 4 只算 1 个 token，实际上是 2~4 个。如果你用中文和 agent 交流，÷ 4 会严重低估，等发现超出窗口时已经晚了。宁可估多一点、早一点压缩。

`CJK` 是一个正则表达式：`/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu`。`\p{Script=Han}` 表示"汉字"，这种写法叫 **Unicode 属性转义**，需要 `u` 标志。

## 4. 什么时候压缩？

### 4.1 阈值

```ts
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}
```

`reserveTokens`（默认 16384）是给模型的回复预留的空间。上下文超过"窗口 - 预留"时就压缩，不要等到真的装不下。

### 4.2 小窗口的模型

固定的默认值有个问题。本地运行的小模型（比如通过 Ollama）可能只有 8K 的窗口：预留 16K 的话，"窗口 - 预留"是负数，每次都要压缩。所以我们按窗口的大小调整：

```ts
export function effectiveSettings(settings: CompactionSettings, contextWindow: number): CompactionSettings {
	const quarter = Math.floor(contextWindow / 4);
	return {
		enabled: settings.enabled,
		reserveTokens: Math.min(settings.reserveTokens, quarter),
		keepRecentTokens: Math.min(settings.keepRecentTokens, quarter),
	};
}
```

这也让我们可以用 `--context-window 8000` 假装模型的窗口很小，用很短的对话就能试验压缩。

### 4.3 在哪里检查？

两个时机：

1. **发送新的问题之前**：`AgentSession.prompt` 先检查一次。
2. **一次运行的两轮之间**：一个任务可能连续调用几十次工具，上下文在运行**中途**就满了。这需要 agent 循环的配合。

第 2 点是这一章对循环的唯一修改：在每一轮开始之前（第一轮除外），调用一个钩子，让外面有机会替换对话。[code/src/agent/loop.ts](code/src/agent/loop.ts)：

```ts
if (!firstTurn) {
	// 给外面一个机会替换对话（比如上下文太长了，压缩一下）
	const replacement = await config.prepareNextTurn?.([...messages], signal);
	if (replacement) messages.splice(0, messages.length, ...replacement);
	await emit({ type: "turn_start" });
}
```

`messages.splice(0, messages.length, ...replacement)` 把数组的全部内容换成新的（数组还是同一个，循环里其他用到它的地方不受影响）。和里程碑 12 的 `beforeToolCall` 一样，循环不知道"压缩"是什么，它只是在合适的时机调用一个函数。

## 5. 切在哪里？

### 5.1 保留最近的消息

最近的消息最重要：模型正在做的事、刚读的文件、刚看到的错误。所以从**最新**的消息往前数，保留大约 `keepRecentTokens`（默认 20000）个 token 的原文，更早的部分总结掉：

```ts
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulated += estimateTokens(messages[i]);
		if (accumulated >= keepRecentTokens) {
			// 从这里往后，找最近的一个可以切开的位置
			for (let j = i; j < messages.length; j++) {
				if (messages[j].role !== "toolResult") return j;
			}
			// 后面全是工具结果：在它们前面的那条助手消息处切开，让工具调用和结果待在一起
			for (let j = i - 1; j >= 0; j--) {
				if (messages[j].role !== "toolResult") return j;
			}
			return 0;
		}
	}
	return 0;
}
```

返回值是"第一条保留的消息"的下标。返回 0 表示全部保留，没有可以压缩的内容。

### 5.2 绝不切在工具结果上

```
用户 ─ 助手（调用 read）─ 工具结果 ─ 助手（调用 bash）─ 工具结果 ─ 助手
                                      ↑
                         只能从这里（或者用户消息、其他助手消息）开始保留
```

如果从一条工具结果开始保留，它对应的工具调用就被总结掉了。发给模型的上下文里出现了一个"没有调用的结果"，服务商会拒绝请求（里程碑 08 的配对规则）。所以切点只能是用户消息或助手消息。

有一种特殊情况：最后一个工具结果特别大（比如读了一个 50KB 的文件），光它自己就超过了 `keepRecentTokens`。这时往后找不到合适的切点，就往前一步，在调用它的那条助手消息处切开：保留"调用 + 结果"这一对。

## 6. 生成总结

### 6.1 把对话变成一篇文章

如果把旧的消息原样发给模型，再加一句"请总结"，模型很可能会把它当成一段正在进行的对话，接着回答最后一个问题。所以我们先把消息转成**一段文字**：

```
[用户]：测试挂了，帮我看看

[助手]：我先运行测试。

[助手调用工具]：bash(command="npm test")

[工具结果]：…… 1 failing ……
```

`serializeConversation` 做的就是这个。两个细节：

- 工具结果最多保留 2000 个字符。总结不需要每个文件的完整内容，而且工具结果通常是上下文里最大的部分。
- 思考内容不放进去。

### 6.2 总结的格式

总结请求的系统提示词：

```
你是一个上下文总结助手。你的任务是阅读一段用户和 AI 助手之间的对话，然后严格按照指定的格式写出一份结构化的总结。不要继续对话，不要回答对话里的任何问题，只输出总结。
```

格式是一份"检查点"，另一个 AI（其实就是压缩之后的模型自己）要靠它继续工作：

```
## 目标
[用户想要完成什么？如果涉及多个任务，可以列出多项]

## 约束和偏好
- [用户提出的约束、偏好和要求]

## 进展
### 已完成
- [x] [已经完成的任务和修改]

### 进行中
- [ ] [正在做的工作]

### 受阻
- [阻碍进展的问题，没有就不写]

## 关键决定
- **[决定]**：[简短的理由]

## 下一步
1. [接下来应该做什么，按顺序]

## 关键上下文
- [继续工作需要的数据、例子、引用]

每一部分都要简洁。准确地保留文件路径、函数名和错误信息。
```

为什么要规定格式？自由发挥的总结，模型往往写成"用户和助手讨论了登录模块的问题……"这种流水账，丢掉了最有用的东西。固定的格式逼着它回答这几个问题：目标是什么？做完了什么？卡在哪里？下一步做什么？最后一句"准确地保留文件路径、函数名和错误信息"也很重要：这些东西差一个字母就没用了。

这个格式来自 pi（`compaction.ts` 里的 `SUMMARIZATION_PROMPT`），我们翻译成了中文。

### 6.3 第二次压缩

对话继续，又满了，再压缩一次。这时已经有一份旧的总结。我们不是重新总结所有东西，而是让模型**更新**旧的总结：把旧总结放在 `<previous-summary>` 标签里，提示词换成"把新的内容合并进去：保留之前的信息，把完成了的事情从'进行中'移到'已完成'……"。

### 6.4 记住动过哪些文件

压缩之后，模型看不到原来的工具调用了，不知道自己读过、改过哪些文件。所以我们从工具调用里把它们找出来，附在总结后面：

```
<read-files>
src/auth.ts
</read-files>

<modified-files>
src/session.ts
</modified-files>
```

`collectFileLists` 还会接上之前的压缩记下的文件，所以这个列表一直是完整的。

### 6.5 失败的情况

- 请求出错：抛出异常。
- 回复被截断（`stopReason: "length"`）：**也要当作失败**。半份总结代替原来的对话，会丢掉大量信息。
- 总结的最大长度：`reserveTokens` 的 80%，保证总结放得进预留的空间。

## 7. 保存和恢复

### 7.1 压缩记录

[code/src/core/session.ts](code/src/core/session.ts) 新增了一种记录：

```ts
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;   // 从这条记录开始的消息保留原文
	tokensBefore: number;       // 压缩前上下文大约有多少 token
	details?: FileLists;        // 读过、改过的文件
}
```

压缩不删除任何东西：原来的消息都还在文件里，只是追加了一条压缩记录。

### 7.2 恢复上下文

```
会话文件里的记录：
  用户1  助手1  用户2  助手2  用户3  助手3  [压缩]  用户4  助手4
                      ↑                    │
               firstKeptEntryId ───────────┘

发给模型的上下文：
  [总结]  用户2  助手2  用户3  助手3  用户4  助手4
```

`buildContext` 的规则：路径上有压缩记录时，用最新的那条——总结，加上从 `firstKeptEntryId` 开始的消息（跳过压缩记录本身），加上压缩之后的消息：

```ts
const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
const compaction = branch[compactionIndex];
let start = 0;
if (compaction?.type === "compaction") {
	context.messages.push(createSummaryMessage(compaction.summary, Date.parse(compaction.timestamp)));
	const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	start = keptIndex !== -1 ? keptIndex : compactionIndex + 1;
}
for (const entry of branch.slice(start)) {
	if (entry.type === "message") context.messages.push(entry.message);
}
```

总结作为一条**用户消息**放在最前面：

```
之前的对话已经被压缩成了下面这份总结：

<summary>
## 目标
……
</summary>
```

恢复一个压缩过的会话（`mini-pi -c`）时，用的也是这套规则，所以重新打开也是从总结开始。

### 7.3 再次压缩从哪里开始？

第二次压缩时，处理的范围从**上次保留的第一条消息**开始，而不是从上次的压缩记录开始：

```ts
let start = 0;
if (previous) {
	const kept = branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
	start = kept !== -1 ? kept : branch.indexOf(previous) + 1;
}
```

上次保留下来的那些消息，这次可能也该总结掉了。它们和上次的总结（作为 `previousSummary`）一起交给模型。

## 8. AgentSession：把它们串起来

[code/src/core/agent-session.ts](code/src/core/agent-session.ts) 的 `compact` 方法就是前面几节的组合：

```ts
async compact(options = {}): Promise<CompactionResult | undefined> {
	// ① 确定范围，找切点。没有可以压缩的内容就直接返回
	const entries = branch.slice(start).filter((entry): entry is MessageEntry => entry.type === "message");
	const cut = findCutPoint(entries.map((entry) => entry.message), settings.keepRecentTokens);
	if (cut === 0) return undefined;

	await this.emit({ type: "compaction_start", reason });
	try {
		// ② 生成总结，附上文件列表
		const toSummarize = entries.slice(0, cut).map((entry) => entry.message);
		const { text } = await generateSummary(toSummarize, model, { previousSummary: previous?.summary, /* …… */ });
		const files = collectFileLists(toSummarize, previous?.details);
		const summary = text + formatFileLists(files);

		// ③ 保存压缩记录，用新的上下文替换 agent 的对话
		this.sessionManager.appendCompaction(summary, entries[cut].id, tokensBefore, files);
		this.agent.state.messages = this.sessionManager.buildContext().messages;
		await this.emit({ type: "compaction_end", reason, result });
		return result;
	} catch (error) {
		await this.emit({ type: "compaction_end", reason, error: /* …… */ });
		throw error;
	}
}
```

几个配套的改动：

**自动压缩**：`compactIfNeeded` 检查阈值，超过就调用 `compact`。它在 `prompt` 发送问题之前调用，也通过 `agent.prepareNextTurn` 在两轮之间调用：

```ts
agent.prepareNextTurn = async (_messages, signal) =>
	(await this.compactIfNeeded(signal)) ? agent.state.messages : undefined;
```

**自动压缩失败不打断用户**：总结请求可能失败（网络问题、服务商出错）。手动 `/compact` 失败就报错；自动压缩失败只发出一个带错误信息的 `compaction_end` 事件，用户的问题照常发送——也许这次还装得下。

**事件**：`AgentSession` 现在有了自己的 `subscribe`，发出 agent 的所有事件，加上 `compaction_start` 和 `compaction_end`。两个模式改为订阅 `AgentSession`，交互模式据此显示"正在压缩……""压缩完成"。

**压缩之后的估算**：刚压缩完、还没有新的回复时，最后一条回复报告的用量是**压缩之前**的（它统计的是完整的上下文）。如果还用它，会以为上下文仍然很大，马上又压缩一次，然后无限循环。所以 `getContextTokens` 先看看压缩记录之后有没有新的用量数据；没有的话，就把消息、系统提示词、工具定义全部按字符数估算。`test/agent-session.test.ts` 的"压缩之后不会马上又压缩"测试检查了这一点。

**统计**：`getStats` 改成统计会话文件里的完整历史，而不是压缩后的上下文。

## 9. 运行

### 9.1 用假模型试验

假模型服务器能识别总结请求（系统提示词里有"上下文总结助手"），从对话里摘出用户的请求和工具调用，拼出一份格式正确的总结。它没有真正的理解，但足够演示整个流程。

先启动假模型服务器，然后在一个新的空目录里：

```bash
mkdir -p /tmp/compact-demo && cd /tmp/compact-demo
seq 1 2000 > numbers.txt            # 一个 2000 行的文件，大约 2200 个 token
mini-pi --context-window 8000       # 假装模型的窗口只有 8000 个 token
```

输入三次 `读取 numbers.txt`。第三次之前（或者第三次运行的中途），你会看到压缩的提示。然后看看会话文件里的压缩记录：

```bash
grep '"compaction"' ~/.mini-pi/sessions/*compact-demo*/*.jsonl
```

再试试手动压缩：`/compact`，或者带上要求：`/compact 重点记住文件的行数`。对话还很短时，会提示"没有可以压缩的内容"。

为什么要在一个新的空目录里？如果目录（或者它的上层目录）里有一个很长的 `AGENTS.md`，系统提示词本身就会占掉大半个"假窗口"，压缩也腾不出多少空间。这本身也是一个有意思的现象：压缩只能缩小**对话**，系统提示词和工具定义的大小是固定的。

### 9.2 用真实模型

```bash
mini-pi --model deepseek/deepseek-chat --context-window 16000
```

让它阅读几个大文件，再让它根据读到的内容做点事。压缩之后，用 `grep` 看看会话文件里的总结：它记住了什么？丢掉了什么？压缩之后让它接着干活，它还记得之前的目标吗？

## 10. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/core/compaction.ts` | `CompactionSettings`、`DEFAULT_COMPACTION_SETTINGS`、`effectiveSettings`、`estimateTextTokens`、`estimateTokens`、`estimateContextTokens`、`shouldCompact`、`findCutPoint`、`serializeConversation`、`SUMMARIZATION_SYSTEM_PROMPT`、`generateSummary`、`FileLists`、`collectFileLists`、`formatFileLists`、`createSummaryMessage` |
| `src/core/session.ts` | 新增 `CompactionEntry`、`appendCompaction`、`getLatestCompaction`；`buildContext` 处理压缩记录 |
| `src/core/agent-session.ts` | 新增 `compact`、`getContextTokens`、`subscribe`、`compactionSettings`；`AgentSessionEvent`、`CompactionReason`、`CompactionResult`、`AgentSessionOptions` |
| `src/agent/types.ts`、`loop.ts`、`agent.ts` | 新增 `PrepareNextTurn` 钩子 |
| `src/modes/repl.ts` | 显示压缩事件；`/compact` 命令 |
| `src/cli/args.ts` | 新增 `--context-window` |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `compaction.test.ts`（10 个测试），`agent-session.test.ts` 新增了 7 个，`session.test.ts` 新增了 2 个，`agent-loop.test.ts` 新增了 1 个。一共 233 个测试。

`agent-session.test.ts` 里的压缩测试都用了一个很小的窗口：`createFauxModel(steps, { contextWindow: 400 })`，再加上大约 100 个 token 的消息（400 个字符），几条消息就能触发压缩。假模型的"剧本"里要预先写好总结请求的回复——总结也是一次模型调用，会消耗剧本里的一步。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 压缩之后，第一次请求就报 400（工具结果没有对应的调用） | 切点落在了工具结果上 |
| 压缩完马上又压缩，没完没了 | 压缩后还在用压缩前的用量数据估算上下文 |
| 模型压缩后忘了自己在干什么 | 总结的提示词没有要求写"目标""进行中""下一步"；或者总结请求的回复被截断了，你却用了它 |
| 总结请求里，模型接着回答了对话里的最后一个问题 | 把消息原样发了过去，而不是先转成一段文字 |
| 恢复会话后，旧的消息又全回来了 | `buildContext` 没有处理压缩记录 |
| 第二次压缩后，第一次总结里的内容丢了 | 第二次压缩时没有把旧的总结作为 `previousSummary` 传进去 |
| 用中文聊了很久，突然报"上下文过长"，却一次都没有压缩过 | 用"字符数 ÷ 4"估算中文，严重低估了 |
| 小窗口的本地模型，每次发消息之前都在压缩 | 预留的空间比窗口还大，用 `effectiveSettings` 按窗口调整 |

## 12. 练习

1. **超出窗口时自动恢复**：即使有了自动压缩，估算也可能不准，请求还是可能因为"上下文过长"而失败。识别这种错误（错误信息里包含 `maximum context length`、`context_length_exceeded` 之类的字样），压缩一次，然后重试。可以用假模型服务器的 `--context-window` 参数制造这种错误。（pi 就是这样做的，它管这叫 overflow recovery。）
2. **显示上下文的使用率**：在交互模式的提示符里显示上下文用了多少：`你（37%）> `。提示：`session.getContextTokens()` 和 `model.contextWindow`。
3. **关闭自动压缩**：加一个 `--no-compact` 参数。
4. **切在一轮的中间**：如果最近的一轮对话（一个用户问题之后的所有消息）本身就超过了 `keepRecentTokens`，切点会落在这一轮的中间，这一轮的问题被总结掉了，后半截的工具调用却保留着。pi 对这种情况单独生成一份"这一轮前半截"的总结。读一读 pi 的 `compaction.ts` 里的 `isSplitTurn`，试着实现它。
5. **思考题**：为什么 pi 在发总结请求时关掉了提示词缓存（`cacheRetention: "none"`）？为什么序列化时要把工具结果截断到 2000 个字符？

## 13. 自测问题

1. 上下文超出窗口时会发生什么？为什么不能等到超出了再处理？
2. 怎样估算当前上下文的 token 数？为什么中文要单独算？
3. 什么时候触发压缩？`reserveTokens` 是干什么的？
4. 为什么在 agent 循环的两轮之间也要检查？是怎样做到的？
5. 切点为什么不能是工具结果？
6. 为什么要先把消息转成一段文字，再请模型总结？
7. 总结为什么要用固定的格式？
8. 压缩之后，为什么不能再用之前的用量数据？
9. 恢复一个压缩过的会话时，发给模型的上下文由哪几部分组成？

<details>
<summary>参考答案</summary>

1. 服务商直接拒绝请求。之后的每次请求都带着同样多的历史，每次都失败。所以要在接近上限时就压缩，留出回复的空间。
2. 最后一条正常完成的回复报告的 `totalTokens`，加上它之后的消息的估算。估算时英文和代码约 4 个字符一个 token，汉字约一个字一个 token，按 ÷ 4 会严重低估中文。
3. 上下文超过"窗口 - reserveTokens"时。`reserveTokens` 是给模型的回复（以及总结本身）预留的空间。
4. 一次运行可能连续调用几十次工具，上下文在中途就会满。循环在每一轮开始前调用 `prepareNextTurn` 钩子，`AgentSession` 在钩子里检查并压缩，返回新的对话替换循环的工作副本。
5. 工具结果必须跟在它的工具调用后面，否则发给模型的上下文不合法，请求会被拒绝。
6. 原样发过去，模型会把它当成正在进行的对话，接着回答最后一个问题，而不是做总结。
7. 固定的格式逼着模型写出继续工作需要的信息（目标、进展、决定、下一步、关键上下文），而不是一段流水账。
8. 那个数字统计的是压缩前的完整上下文。继续用它会以为上下文仍然很大，导致反复压缩。
9. 最新那条压缩记录的总结（作为一条用户消息）、从 `firstKeptEntryId` 开始保留的消息、压缩之后的消息。

</details>

## 14. 对照 pi 源码

- **文档**：[docs/compaction.md](../../packages/coding-agent/docs/compaction.md) 详细描述了 pi 的压缩：什么时候触发（`contextTokens > contextWindow - reserveTokens`，默认 16384）、怎样找切点（默认保留 20000 个 token）、"Never cut at tool results"、`CompactionEntry` 的结构、总结的格式、`serializeConversation` 的输出（`[User]:`、`[Assistant]:`、`[Assistant tool calls]:`、`[Tool result]:`）、工具结果截断到 2000 个字符……和我们这一章几乎一一对应。文档里的那几张图值得仔细看。
- **[compaction/compaction.ts](../../packages/coding-agent/src/core/compaction/compaction.ts)**：
  - `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`、`estimateContextTokens`（同样是"最后一次用量 + 之后的估算"）、`estimateTokens`（字符数 ÷ 4）；
  - `findCutPoint` 和 `findValidCutPoints`：注释里写着 "Never cut at tool results (they must follow their tool call)"，以及后面全是工具结果时"keep their preceding assistant tool call"；
  - `SUMMARIZATION_PROMPT` 和 `UPDATE_SUMMARIZATION_PROMPT`：我们的中文提示词就是照着它们翻译的；
  - `getSummarizationFailure`："A length stop contains partial text and must not become a session checkpoint"；
  - `estimateProjectedContextTokens`：压缩（或者编辑上下文）之后，不再信任之前的用量数据——对应我们的 `getContextTokens`；
  - `isSplitTurn` 和 `TURN_PREFIX_SUMMARIZATION_PROMPT`：切在一轮中间时的特殊处理（练习 4）。
- **[compaction/utils.ts](../../packages/coding-agent/src/core/compaction/utils.ts)**：`serializeConversation`、`SUMMARIZATION_SYSTEM_PROMPT`、文件跟踪（`extractFileOpsFromMessage`、`computeFileLists`、`formatFileOperations`）。
- **总结消息的包装**：[messages.ts](../../packages/coding-agent/src/core/messages.ts) 里的 `COMPACTION_SUMMARY_PREFIX`："The conversation history before this point was compacted into the following summary:"，后面跟着 `<summary>` 标签。pi 用一种专门的消息类型 `compactionSummary` 保存它，发给模型时转换成用户消息。
- **什么时候检查**：pi 在发送新问题之前、两轮之间（`prepareNextTurn`，和我们的钩子同名）检查；另外，如果请求因为上下文过长而失败，会压缩之后自动重试一次（练习 1）。
- **分支总结**：[compaction/branch-summarization.ts](../../packages/coding-agent/src/core/compaction/branch-summarization.ts)。用 `/tree` 跳到另一个分支时，pi 会把离开的那个分支总结一下，带到新的分支里。原理和压缩一样。
- **扩展**：pi 的扩展可以监听 `session_before_compact` 事件，取消压缩，或者提供自己的总结（文档的 "Custom Summarization via Extensions" 一节）。

## 15. 闭卷挑战

不看资料，写出：

1. `estimateContextTokens` 和 `findCutPoint`；
2. `serializeConversation` 和 `generateSummary`（提示词可以简化）；
3. `SessionManager.buildContext` 对压缩记录的处理；
4. `AgentSession.compact`。

让 `test/compaction.test.ts` 和 `test/agent-session.test.ts` 全部通过。

---

**第四阶段完成。** mini-pi 现在能记住对话、恢复会话、在长时间的工作中自动压缩上下文——这些都是"能用"和"好用"之间的差距。

下一阶段我们回到界面：现在的交互模式只是一行一行地打印文字，输出一长，屏幕就乱成一团。我们要从最底层的终端控制开始，写一个像 pi 那样的全屏界面。

上一步：[里程碑 14：会话](../14-sessions/README.md) · 下一步：[里程碑 16：终端基础](../16-terminal/README.md)
