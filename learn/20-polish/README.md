# 里程碑 20：打磨——mini-pi v1.0

> 目标：把 mini-pi 从"能用"打磨到"好用"。服务器偶尔出错时自动重试，上下文超出上限时自动恢复，用设置文件保存自己的习惯，在界面里切换模型，用斜杠命令做各种事情。做完这一章，就是 mini-pi v1.0。
>
> 完成后你将拥有：`Agent.continue()`、`src/core/retry.ts`、`src/core/settings.ts`、选择列表组件 `SelectList`，以及交互模式里的 `/help`、`/model`、`/session`、`/settings` 命令。

```
 > 你好

 出错了：HTTP 429：Rate limit exceeded, please retry later

 ⠋ 出错了，2 秒后第 1/3 次重试……（Esc 打断）

────────────────────────────────────────────────────────────────
 /model
────────────────────────────────────────────────────────────────
 筛选：deep
 › deepseek/deepseek-chat  DeepSeek
   deepseek/deepseek-reasoner  DeepSeek
   deepseek-anthropic/deepseek-chat  DeepSeek（Anthropic 协议）
```

## 你将学到

- 区分临时性的错误和永久性的错误；指数退避
- `Agent.continue()`：不加新消息，从当前的对话继续
- 上下文超出上限时怎样恢复
- 设置文件：默认值、合并、校验——复用里程碑 08 的校验函数
- 选择列表组件
- 斜杠命令：一张命令表，自动生成帮助、提示和补全
- 一个项目怎样才算"完成"

---

## 1. 问题：真实世界里的小毛病

用 mini-pi 干了一段时间的活，你会遇到这些问题：

1. 服务商偶尔返回 `HTTP 503`（服务器太忙）或 `HTTP 429`（请求太频繁），网络偶尔断一下。一次失败，正在进行的任务就停了，只能手动说"继续"。（里程碑 03 的错误表里说过："里程碑 20 会实现自动重试"。）
2. 上下文的 token 数是**估算**的（里程碑 15），估少了的时候，请求会因为"上下文太长"直接失败。
3. 每次都要在命令行里写 `--model`；某个快捷键和终端冲突了，想换一个。
4. 想换个模型试试，只能退出重来。
5. 命令越来越多，记不住都有哪些。

这一章逐个解决它们。没有新的大概念，全是让程序更可靠、更顺手的细节——真正的软件，大部分时间都花在这些细节上。

## 2. 自动重试

### 2.1 什么样的错误值得重试

有的错误等一会儿就好了，有的错误重试多少次都没用：

| 错误 | 例子 | 重试？ |
| --- | --- | --- |
| 服务器太忙、内部出错 | `HTTP 503`、`HTTP 500`、`overloaded` | 重试 |
| 请求太频繁 | `HTTP 429`、`rate limit` | 重试 |
| 网络问题 | `fetch failed`、`ECONNRESET`、超时、连接中断 | 重试 |
| API key 不对 | `HTTP 401` | 不重试 |
| 参数不对 | `HTTP 400` | 不重试 |
| 额度用完了 | `HTTP 429` + `insufficient_quota` | 不重试 |

最后一行要注意：有的服务商用 429 表示"额度用完了"，它看起来像"请求太频繁"，可是重试一百次也不会好。所以先排除这类错误，再看是不是临时性的：

```ts
const NOT_RETRYABLE_PATTERN = /insufficient_quota|quota exceeded|billing|余额不足/i;

export function isRetryableError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (NOT_RETRYABLE_PATTERN.test(message.errorMessage)) return false;
	return RETRYABLE_PATTERN.test(message.errorMessage);
}
```

`RETRYABLE_PATTERN` 是一个由很多小模式拼起来的正则表达式（`HTTP (429|5\d\d)`、`overloaded`、`fetch failed`……）。错误的判断只能靠错误信息里的文字，因为各家服务商的说法都不一样。pi 的这个列表有几十项，很多项旁边还注明了是在哪个 issue 里遇到的——这样的知识只能在真实使用中一点点积累。

### 2.2 等多久：指数退避

为什么不马上重试？服务器返回 503，说明它已经忙不过来了。如果所有客户端都立刻重试，服务器只会更忙。所以要**等一会儿**，而且每失败一次，等的时间**翻倍**：

```
第 1 次重试前等 2 秒
第 2 次重试前等 4 秒
第 3 次重试前等 8 秒
还不行就放弃，把错误留给用户
```

```ts
export function retryDelayMs(settings: RetrySettings, attempt: number): number {
	return settings.baseDelayMs * 2 ** (attempt - 1);
}
```

这叫**指数退避**（exponential backoff），几乎所有网络程序都这样做。默认的参数和 pi 一样：最多重试 3 次，第一次等 2 秒。

### 2.3 从哪里重新开始：`Agent.continue()`

回复失败之后，对话是这样的：

```
用户：帮我修复测试
助手：（读取文件）
工具结果：……
助手：出错了：HTTP 503      ← 失败的回复
```

重试的意思是：**去掉失败的那条回复，用同样的对话再请求一次模型**。不能用 `prompt()`，因为它会加一条新的用户消息。里程碑 10 提到过，pi 的 `Agent` 有一个 `continue()` 方法：不加新消息，从当前的对话继续运行。我们把 `prompt` 里运行循环的部分提取成 `run(prompts)`，`continue()` 就是 `run([])`：

```ts
async prompt(input: string | Message | Message[]): Promise<void> {
	if (this.activeRun) {
		throw new Error("agent 正在运行。请用 steer() 或 followUp() 排队，或者等它完成。");
	}
	await this.run(typeof input === "string" ? [userMessage(input)] : Array.isArray(input) ? input : [input]);
}

async continue(): Promise<void> {
	if (this.activeRun) throw new Error("agent 正在运行，不能继续。");
	const last = this.state.messages.at(-1);
	if (!last || last.role === "assistant") throw new Error("没有可以继续的内容：对话是空的，或者最后一条是助手的回复。");
	await this.run([]);
}
```

agent loop 本来就支持一条新消息都没有的情况（里程碑 09 写的 `for (const prompt of prompts)` 循环零次而已），一行都不用改。

为什么最后一条不能是助手的回复？那样模型会看到"自己刚说完话"，再请求一次，它要么重复，要么什么也不说。所以重试之前一定要先去掉失败的回复。

### 2.4 重试的流程

重试放在 `AgentSession` 里，因为 print 模式、逐行模式、交互模式都需要它：

```ts
async prompt(input: string): Promise<void> {
	await this.compactIfNeeded();
	await this.agent.prompt(input);
	await this.recover(); // 回复失败了？补救一下
}

private async recover(): Promise<void> {
	let attempt = 0;
	let compacted = false;
	while (true) {
		const failed = this.lastFailure();
		if (!failed) {
			if (attempt > 0) await this.emit({ type: "retry_end", success: true, attempt });
			return;
		}
		if (isContextOverflow(failed) && !compacted) {
			// ……见 2.5 节
		}
		if (!this.retrySettings.enabled || !isRetryableError(failed)) return;
		if (attempt >= this.retrySettings.maxRetries) {
			await this.emit({ type: "retry_end", success: false, attempt, error: failed.errorMessage });
			return;
		}
		attempt++;
		const delayMs = retryDelayMs(this.retrySettings, attempt);
		await this.emit({ type: "retry_start", attempt, maxRetries: this.retrySettings.maxRetries, delayMs, error: failed.errorMessage ?? "" });
		this.retryController = new AbortController();
		const waited = await sleep(delayMs, this.retryController.signal);
		this.retryController = undefined;
		if (!waited) {
			await this.emit({ type: "retry_end", success: false, attempt, error: "重试被取消了" });
			return;
		}
		this.dropTrailingFailures(); // 去掉失败的回复
		await this.agent.continue();
	}
}
```

几个细节：

- **用户按 Esc 取消的回复不算失败**：它的 `stopReason` 是 `aborted`，`lastFailure()` 只认 `error`。
- **等待也要能取消**：等 8 秒的时候用户按了 Esc，不能让他干等。`sleep` 接受一个 `AbortSignal`（第 2 章学过的取消机制），`AgentSession.abort()` 同时取消正在等待的重试和正在运行的 agent。交互模式和逐行模式的"打断"都改成调用它。
- **失败的回复只从对话里去掉**，会话文件里还留着它们——那是真实发生过的事。发给模型时，适配器本来就会跳过失败的回复（里程碑 07 的 `transform.ts`）。
- 两个新的事件 `retry_start`、`retry_end`，让界面告诉用户发生了什么："出错了，2 秒后第 1/3 次重试……"

注意交互模式里"是否在忙"的判断：等待重试的时候，agent 并没有在运行（`isStreaming` 是 false），但我们还在处理这条消息。这正是里程碑 19 用自己的 `busy` 而不是 `isStreaming` 的原因。逐行模式也改成了用 `running` 判断。

### 2.5 上下文超出上限

估算的 token 数偏少时，请求会失败，错误信息说的是"上下文太长"（`context_length_exceeded`、`maximum context length`……各家说法不一样）。这时等多久都没用，但**压缩一下**就有用：

```ts
if (isContextOverflow(failed) && !compacted) {
	compacted = true;
	const result = await this.compact({ reason: "overflow" }).catch(() => undefined);
	if (!result) return; // 没有可以压缩的内容（比如一条消息本身就太长了），只能放弃
	this.dropTrailingFailures();
	await this.agent.continue();
	continue;
}
```

只压缩一次。如果压缩之后还是太长，说明问题不在旧的对话（比如刚读了一个巨大的文件），再压缩也没用。pi 也是只恢复一次。

## 3. 设置文件

### 3.1 有哪些设置

```ts
export interface Settings {
	/** 默认的模型，比如 "deepseek/deepseek-chat" */
	defaultModel?: string;
	/** 执行危险的命令之前先问用户 */
	confirmDangerous: boolean;
	compaction: CompactionSettings;
	retry: RetrySettings;
	/** 自定义快捷键，比如 { "input.submit": ["ctrl+s"] } */
	keybindings: Partial<Record<KeyAction, string[]>>;
}
```

一个设置文件的例子（`~/.mini-pi/settings.json`）：

```json
{
	"defaultModel": "deepseek/deepseek-chat",
	"retry": { "maxRetries": 5 },
	"keybindings": { "editor.cursorWordLeft": ["alt+left", "ctrl+left"] }
}
```

没写的设置用默认值。嵌套的设置要**单独合并**：只写了 `"retry": { "maxRetries": 5 }`，`enabled` 和 `baseDelayMs` 仍然是默认值。如果直接用 `{ ...DEFAULT_SETTINGS, ...file }`，`retry` 会被整个替换成 `{ maxRetries: 5 }`，另外两个就变成 `undefined` 了。

### 3.2 校验：复用里程碑 08 的代码

用户手写的 JSON 难免出错：拼错了名字（`confirmDanger`）、类型写错了（`"maxRetries": "5"`）。还记得里程碑 08 校验工具参数的 `validateValue` 吗？它按 JSON Schema 检查一个值，错误信息写得清清楚楚。设置文件也是 JSON，正好拿来用：

```ts
const SETTINGS_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false, // 不认识的名字也报错：多半是拼错了
	properties: {
		defaultModel: { type: "string" },
		confirmDangerous: { type: "boolean" },
		retry: {
			type: "object",
			additionalProperties: false,
			properties: { enabled: { type: "boolean" }, maxRetries: { type: "integer" }, baseDelayMs: { type: "integer" } },
		},
		keybindings: {
			type: "object",
			additionalProperties: false,
			// 每个动作都可以设置成一组按键：从快捷键表自动生成
			properties: Object.fromEntries(
				Object.keys(DEFAULT_KEYBINDINGS).map((action) => [action, { type: "array", items: { type: "string" } }]),
			),
		},
		// ……
	},
};
```

`keybindings` 的格式是从快捷键表**自动生成**的：以后加了新的动作，设置文件自动就能配置它，不用改两个地方。

文件有问题时怎么办？我们选择**整个文件都不用**，并且把所有的错误告诉用户：

```
设置文件有错误，已忽略：/home/me/.mini-pi/settings.json
settings.confirmDanger：不认识的参数
settings.retry.maxRetries：必须是整数，实际是 string
```

为什么不只忽略写错的那几项？那样用户会很困惑："为什么我的设置有的生效、有的不生效？"要么全部生效，要么全部不生效并且说明原因，行为更容易理解。交互模式在对话开头用黄色显示这些错误，print 模式输出到 stderr。

### 3.3 设置在哪里生效

| 设置 | 在哪里用 |
| --- | --- |
| `defaultModel` | `cli.ts` 选择模型的顺序：`--model` > 会话里记录的模型 > 环境变量 `MINI_PI_MODEL` > `defaultModel` > `fake/fake-model` |
| `confirmDangerous` | 交互模式、逐行模式的 `confirmDangerous` 选项 |
| `compaction`、`retry` | `new AgentSession(agent, sessionManager, { compaction, retry })` |
| `keybindings` | `setKeybindings(settings.keybindings)`（里程碑 18 预留的接口） |

环境变量排在设置文件前面：环境变量是"这一次"的临时选择，设置文件是"一直以来"的习惯，临时的选择应该优先。

## 4. 选择列表

切换模型、以后选择会话，都需要一个"从列表里选一项"的组件：

```
 筛选：deep█
 › deepseek/deepseek-chat  DeepSeek
   deepseek/deepseek-reasoner  DeepSeek
   deepseek-anthropic/deepseek-chat  DeepSeek（Anthropic 协议）
```

状态只有四个：所有的项目、筛选的文字、选中的是第几项、滚动到了哪里。

- **上下方向键**移动（`select.up`、`select.down`，也可以用 Ctrl+P / Ctrl+N），到了头就转到另一头；
- **回车**确认，**Esc** 取消；
- **直接打字**筛选：名字和说明里包含输入的每一个词（不区分大小写）就留下。退格删掉筛选的最后一个字；
- 项目太多时只显示 `maxVisible` 项，跟着选中的项目滚动（和编辑器的上下滚动一样）。

筛选框里也输出了光标标记：用输入法输入中文筛选（比如"通义"）时，候选词窗口出现在筛选框里。

## 5. 切换模型：`/model`

```ts
private selectModel(spec: string): void {
	// ……
	const items = PROVIDERS.flatMap((provider) =>
		provider.models.map((model) => ({
			value: `${provider.id}/${model.id}`,
			label: `${provider.id}/${model.id}`,
			description: getApiKey(provider.id) ? provider.name : `${provider.name}（没有 API key）`,
		})),
	);
	const list = new SelectList(items, { maxVisible: 10, selectedValue: currentSpec });
	list.onSelect = (item) => {
		this.closeSelector();
		this.switchModel(item.value);
	};
	list.onCancel = () => this.closeSelector();
	this.showSelector(list);
}
```

- 列表来自模型表（里程碑 07），没有 API key 的服务商标注出来；
- `showSelector` 把输入框换成选择列表，和确认对话框、pi 的 `showSelector` 是同一个办法；
- 选好之后调用 `session.setModel(model)`：它会在会话文件里记一条 `model_change`（里程碑 14），下次用 `-c` 继续时还是这个模型；
- 也可以直接写 `/model deepseek/deepseek-chat`。

中途换模型，之前的对话会原样发给新的模型。里程碑 08 定下的规则这时起了作用：别的模型的"思考过程"不会发给新的模型。

## 6. 斜杠命令

命令多了，就把它们整理成一张表：

```ts
private readonly commands: SlashCommand[] = [
	{ name: "help", description: "显示所有命令和快捷键", run: () => this.showHelp() },
	{ name: "model", description: "切换模型；/model 服务商/模型 直接切换", run: (args) => this.selectModel(args) },
	{ name: "compact", description: "压缩上下文，可以附加要求，比如 /compact 保留所有文件路径", run: (args) => void this.compact(args || undefined) },
	{ name: "new", description: "开始新的会话", run: () => this.newSession() },
	{ name: "session", description: "显示当前会话的信息", run: () => this.showSessionInfo() },
	{ name: "settings", description: "显示设置文件的位置和当前的设置", run: () => this.showSettings() },
	{ name: "quit", description: "退出", run: () => void this.exit() },
];
```

有了这张表，很多功能都是"顺便"得到的：

- **提交时查表**：`/model deepseek/deepseek-chat` 找到 `model` 命令，把后面的 `deepseek/deepseek-chat` 作为参数。**不认识的** `/xxx` 当作普通的消息发给模型——用户可能在问"/usr/bin 里有什么"。
- **提示**：输入框里的内容以 `/` 开头、还没有空格时，在输入框下面列出匹配的命令。
- **补全**：按 Tab（动作 `app.complete`）补全成第一个匹配的命令。
- **帮助**：`/help` 根据命令表和快捷键表生成，永远不会过时。用户改了快捷键，帮助里显示的也是新的按键。

和快捷键表一样，这是"把数据和逻辑分开"：要加一个命令，只要在表里加一行。

## 7. 运行

**自动重试**：假模型服务器有一个现成的剧本，第一次返回 429，第二次正常回答：

```bash
node learn/tools/fake-llm/server.ts --port 4001 --script learn/tools/fake-llm/scripts/rate-limit-then-ok.json
```

```bash
LLM_BASE_URL=http://localhost:4001/v1 LLM_API_KEY=fake node src/cli.ts --no-session --model custom/fake-model
```

随便说一句话，你会看到"出错了，2 秒后第 1/3 次重试……"，然后是"重试成功了！"。再试一次，在等待的时候按 Esc 取消重试。

**上下文超出上限**：让服务器只接受 9000 个 token，而 mini-pi 以为上下文有 24000（估算不准的情况）：

```bash
node learn/tools/fake-llm/server.ts --port 4002 --context-window 9000
```

```bash
LLM_BASE_URL=http://localhost:4002/v1 LLM_API_KEY=fake node src/cli.ts --no-session --model custom/fake-model --context-window 24000
```

输入 `运行 seq 1 20000 然后 运行 seq 1 20000 然后 运行 seq 1 20000`。第三个命令的结果让请求超出了 9000，服务器拒绝；mini-pi 自动压缩，然后继续。

**设置文件、切换模型、命令**：在 `~/.mini-pi/settings.json` 里写几个设置（故意写错一个试试），启动 mini-pi，输入 `/settings` 看看生效的设置；输入 `/mo` 按 Tab，再按回车，在列表里选一个模型；输入 `/help`。

## 8. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/agent/agent.ts` | 新增 `continue()`；`prompt` 和 `continue` 共用私有的 `run(prompts)` |
| `src/core/retry.ts` | `RetrySettings`、`DEFAULT_RETRY_SETTINGS`、`isRetryableError`、`isContextOverflow`、`retryDelayMs`、`sleep(ms, signal)` |
| `src/core/agent-session.ts` | 选项 `retry`；`prompt` 之后自动重试、上下文超限时压缩恢复；`abort()`；事件 `retry_start`、`retry_end`；压缩原因新增 `overflow` |
| `src/core/settings.ts` | `Settings`、`DEFAULT_SETTINGS`、`getSettingsPath`、`loadSettings(agentDir)` → `{ settings, errors }` |
| `src/tui/components/select-list.ts` | `SelectList(items, { maxVisible, selectedValue })`：`onSelect`、`onCancel` |
| `src/tui/keybindings.ts` | 新增 `select.up`、`select.down`、`select.confirm`、`select.cancel`、`app.complete` |
| `src/modes/interactive/interactive-mode.ts` | 命令表、命令提示和补全、`/help`、`/model`、`/session`、`/settings`；显示重试；选项 `settings`、`settingsPath`、`warnings` |
| `src/cli.ts` | 读取设置并应用；`--help` 里说明设置文件 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `retry.test.ts`（8 个测试）、`settings.test.ts`（4 个）、`select-list.test.ts`（5 个）、`commands.test.ts`（7 个），`cli.test.ts` 新增 2 个，一共 348 个测试。

## 9. 常见错误

| 现象 | 原因 |
| --- | --- |
| API key 填错了，程序却等了很久才报错 | 把 401 也当成了临时性的错误在重试 |
| 重试时模型的回答重复了，或者什么也没说 | 重试之前没有去掉失败的回复，对话以助手的回复结尾 |
| 等待重试时按 Esc 没反应 | 等待不能取消：`sleep` 没有接受 `AbortSignal`，或者只取消了 agent |
| 等待重试时输入的消息变成了一次新的运行 | 用 `isStreaming` 判断"是否在忙"，等待重试时它是 false |
| 设置里只写了 `retry.maxRetries`，重试却不工作了 | 嵌套的设置没有单独合并，`enabled` 变成了 `undefined` |
| 拼错了设置的名字，却没有任何提示 | 校验时没有 `additionalProperties: false` |
| 输入 `/usr/bin 里有什么`，提示"不认识的命令" | 把所有 `/` 开头的输入都当成了命令 |

## 10. 练习

1. **抖动**：给等待时间加上随机的 0~20%（`delay * (1 + Math.random() * 0.2)`）。想一想：成千上万的客户端在同一时刻遇到 503，如果它们都等正好 2 秒，会发生什么？
2. **Retry-After**：服务器返回 429 时，响应头里常常有一个 `Retry-After`，告诉你等几秒。把它带到错误信息里，重试时按它说的等。
3. **/resume**：在界面里用选择列表选择一个会话，切换过去。提示：`AgentSession` 现在不能更换 `SessionManager`，你需要先解决这个问题。
4. **项目设置**：读取项目里的 `.mini-pi/settings.json`，覆盖全局的设置。想一想：哪些设置**不应该**允许项目覆盖？（提示：如果你克隆了一个别人的仓库，它的设置文件里写着 `"confirmDangerous": false`……）
5. **循环切换模型**：加一个快捷键（pi 是 Ctrl+P），在几个常用的模型之间轮流切换，不用打开列表。
6. **命令的参数补全**：输入 `/model ` 之后按 Tab，补全模型的名字。

## 11. 自测问题

1. 什么样的错误值得重试？为什么 429 有时候不能重试？
2. 什么是指数退避？为什么不马上重试？
3. `continue()` 和 `prompt()` 有什么区别？为什么重试之前要去掉失败的回复？
4. 为什么等待重试也要能取消？怎么做到的？
5. 上下文超出上限时怎么恢复？为什么只恢复一次？
6. 设置文件里嵌套的设置为什么要单独合并？
7. 设置文件有错误时，为什么整个文件都不用？
8. 斜杠命令整理成一张表，带来了哪些好处？

<details>
<summary>参考答案</summary>

1. 临时性的错误：服务器太忙或内部出错（5xx）、请求太频繁（429）、网络问题、超时。有的服务商用 429 表示额度用完了，重试多少次都没用，所以要先排除。
2. 每失败一次，等待的时间翻倍（2 秒、4 秒、8 秒）。服务器已经忙不过来了，所有客户端都马上重试只会让它更忙。
3. `prompt()` 先加一条新的用户消息，`continue()` 不加新消息，直接用当前的对话请求模型。对话以助手的回复结尾时，模型会以为自己已经说完了，要么重复、要么什么也不说。
4. 最长要等好几秒，用户可能不想等了。`sleep` 接受一个 `AbortSignal`，`AgentSession.abort()` 同时取消等待和 agent 的运行。
5. 压缩上下文，去掉失败的回复，然后 `continue()`。压缩之后还超出，说明问题不在旧的对话里（比如一条消息本身太长），再压缩也没用。
6. 展开运算符只合并第一层：`{ ...DEFAULT_SETTINGS, ...file }` 会把整个 `retry` 换成文件里的那个不完整的对象。
7. 只忽略写错的部分，用户会搞不清哪些设置生效了。全部不用并且列出所有错误，行为更容易理解。
8. 提交时查表、输入时的提示、Tab 补全、`/help` 都根据同一张表生成；加一个命令只要加一行；帮助永远和实际的命令一致。

</details>

## 12. 对照 pi 源码

- **自动重试**：[packages/ai/src/utils/retry.ts](../../packages/ai/src/utils/retry.ts) 的 `isRetryableAssistantError` 和 `retryDelayMs`，读一读那几十个错误模式，以及注释里提到的 issue 编号。[agent-session.ts](../../packages/coding-agent/src/core/agent-session.ts) 里搜索 `_prepareRetry`：同样是发出 `auto_retry_start` 事件、等待（可以用 `abortRetry` 取消）、然后让 agent 继续。默认参数见 [docs/settings.md](../../packages/coding-agent/docs/settings.md) 的 `retry.*`。pi 把失败的回复留在原始的历史记录里，只是不再发给模型，和我们的做法一样。
- **上下文超限**：`agent-session.ts` 的 `_checkCompaction` 上面的注释列出了三种情况，第一种就是"超出上限：去掉失败的回复，压缩，重试一次"。
- **`Agent.continue()`**：[packages/agent/src/agent.ts](../../packages/agent/src/agent.ts)。它还处理了一种情况：最后一条是助手的回复、但是有排队的消息时，把排队的消息发出去。
- **设置**：[settings-manager.ts](../../packages/coding-agent/src/core/settings-manager.ts)，设置项比我们多得多。pi 还会读取项目里的 `.pi/settings.json` 覆盖全局的设置，并且有"项目信任"的机制（练习 4 的思考题）。
- **选择模型**：[model-selector.ts](../../packages/coding-agent/src/modes/interactive/components/model-selector.ts)；Ctrl+P 在常用的模型之间循环切换。
- **斜杠命令**：`interactive-mode.ts` 的提交处理里逐个判断几十个命令；扩展也可以注册自己的命令。输入 `/` 时弹出的补全菜单来自 tui 包的 [autocomplete.ts](../../packages/tui/src/autocomplete.ts)，可以用方向键选择。
- **选择列表**：[packages/tui/src/components/select-list.ts](../../packages/tui/src/components/select-list.ts)。

## 13. 闭卷挑战

不看资料，写出：

1. `isRetryableError`（至少处理 429、5xx、网络错误，排除额度用完）和 `retryDelayMs`；
2. `Agent.continue()` 和 `AgentSession` 的重试循环；
3. `loadSettings`：默认值、嵌套合并、出错时忽略整个文件。

让 `test/retry.test.ts` 和 `test/settings.test.ts` 的大部分测试通过。

## 14. mini-pi v1.0

到这里，mini-pi 完成了。数一数你写了多少代码：

```bash
find src -name "*.ts" | xargs wc -l
```

参考答案大约 8300 行（去掉注释和空行大约 6400 行），测试大约 5500 行：

| 目录 | 内容 | 行数 |
| --- | --- | --- |
| `src/ai/` | 消息类型、事件流、SSE 解析、OpenAI 和 Anthropic 适配器、假模型、模型表 | 约 1750 |
| `src/agent/` | agent loop、Agent 类、参数校验 | 约 830 |
| `src/tools/` | read、write、edit、ls、bash，截断、diff | 约 1000 |
| `src/core/` | 系统提示词、会话、压缩、重试、设置 | 约 1280 |
| `src/tui/` | 终端、按键、宽度、差分渲染、编辑器、Markdown、选择列表 | 约 2000 |
| `src/modes/` | print 模式、逐行模式、交互模式 | 约 1170 |
| `src/cli*` | 命令行参数、入口 | 约 320 |

每一行你都亲手写过，每一个设计你都知道为什么。零依赖：HTTP、流式解析、参数校验、终端界面，全是你自己的代码。

接下来的两章：先带着你学到的东西去读真正的 pi，看看一个被成千上万人使用的 coding agent 多了些什么；最后，合上教程，从一个空目录开始，不借助 AI，把 mini-pi 重新写一遍。

---

上一步：[里程碑 19：交互模式](../19-interactive/README.md) · 下一步：[里程碑 21：读懂真正的 pi](../21-read-pi/README.md)
