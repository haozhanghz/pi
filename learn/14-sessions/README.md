# 里程碑 14：会话

> 目标：把对话保存到文件里。关掉程序，明天用 `mini-pi -c` 接着聊；用 `mini-pi -r` 从历史会话里挑一个继续。
>
> 完成后你将拥有：`src/core/session.ts`（会话文件的读写）、`src/core/agent-session.ts`（把 agent 和会话粘在一起），以及 `-c`、`-r`、`--session`、`--no-session` 四个参数。

```
$ mini-pi
你> 我在重构登录模块，先帮我看看 src/auth.ts
……
你> （按 Ctrl+D）
本次会话：1 个问题，调用工具 3 次，共 18342 tokens，$0.0071
会话已保存，下次用 mini-pi -c 继续：~/.mini-pi/sessions/--home-you-todo-app--/2026-10-12T23-14-48-643Z_564ebfeb….jsonl

（第二天）
$ mini-pi -c
已恢复会话，共 8 条消息：

你> 我在重构登录模块，先帮我看看 src/auth.ts
> read src/auth.ts
……
你> 接着昨天的，把 session 的过期时间改成可配置的
```

## 你将学到

- JSONL：为什么用"每行一个 JSON"保存会话
- 只追加、从不修改：可靠地写文件
- 用 `id` 和 `parentId` 把记录连成一棵树，不删除任何东西就能"回到过去"
- 从事件到文件：在 `message_end` 时保存每条消息
- `AgentSession`：模式和 agent 之间的中间层
- 读到坏掉的数据时怎么办

---

## 1. 问题：关掉程序，一切都没了

到现在为止，对话只存在内存里（`agent.state.messages`）。按下 Ctrl+D，几个小时的工作上下文就消失了：模型读过哪些文件、你们讨论过什么方案、做到了哪一步……第二天只能从头解释一遍。

我们需要把对话保存下来，并且能恢复。

## 2. 文件格式：JSONL

### 2.1 一个真实的会话文件

```
{"type":"session","version":1,"id":"564ebfeb-b2c3-4002-88c5-be025c7b1477","timestamp":"2026-10-12T23:14:48.643Z","cwd":"/home/you/todo-app"}
{"type":"model_change","id":"42f6d7f9","parentId":null,"timestamp":"2026-10-12T23:14:48.646Z","provider":"deepseek","modelId":"deepseek-chat"}
{"type":"message","id":"880dd1e6","parentId":"42f6d7f9","timestamp":"2026-10-12T23:14:49.438Z","message":{"role":"user","content":"计算 6*7","timestamp":1791846889437}}
{"type":"message","id":"39637d1b","parentId":"880dd1e6","timestamp":"2026-10-12T23:14:50.678Z","message":{"role":"assistant","content":[{"type":"text","text":"6×7 = 42。"}],"api":"openai-completions",……}}
```

**JSONL**（JSON Lines）就是"每行一个 JSON 对象"。为什么不把整个会话存成一个大的 JSON 数组？

| | 一个 JSON 数组 | JSONL |
| --- | --- | --- |
| 加一条消息 | 读出整个文件、改数组、把整个文件写回去 | 在文件末尾追加一行 |
| 写到一半程序崩溃 | 整个文件可能坏掉（少了结尾的 `]`） | 最多最后一行坏掉，前面的都好好的 |
| 很大的文件 | 必须整个读进内存才能解析 | 可以一行一行地读 |
| 用工具查看 | 需要专门的工具 | `tail -f` 实时看，`grep` 直接搜 |

日志、数据库的预写日志（WAL）、很多聊天程序的存档，都用"只追加"的方式。

### 2.2 记录的种类

[code/src/core/session.ts](code/src/core/session.ts)：

```ts
/** 文件的第一行：会话的基本信息 */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;            // 在哪个目录里开始的这个会话
}

interface EntryBase {
	id: string;             // 8 位十六进制的短 id
	parentId: string | null; // 上一条记录的 id。第一条记录是 null
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: Message;       // 原封不动的消息对象
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";   // 换了模型
	provider: string;
	modelId: string;
}

export type SessionEntry = MessageEntry | ModelChangeEntry;
```

- **第一行是文件头**：会话的 id、创建时间、工作目录、格式的版本号。版本号很重要：以后格式变了，读文件的代码可以根据版本号做转换（pi 的会话格式已经是第 3 版了）。
- **消息原封不动地保存**：包括工具结果的 `details`（diff、截断信息），恢复之后界面可以照样显示。
- **换模型也是一条记录**：恢复会话时接着用原来的模型。下一章还会加上"压缩"记录。

### 2.3 存在哪里？

```
~/.mini-pi/sessions/--home-you-todo-app--/2026-10-12T23-14-48-643Z_564ebfeb-….jsonl
```

- **每个工作目录一个文件夹**：路径里的 `/` 换成 `-`，前后加上 `--`，变成一个合法的文件夹名。`mini-pi -c` 只在当前目录的文件夹里找，不会把 A 项目的对话接到 B 项目里。
- **文件名以时间开头**：按文件名排序就是按时间排序。时间里的 `:` 和 `.` 换成了 `-`，因为 Windows 的文件名里不能有 `:`。
- **后面是会话的 id**：一个随机的 UUID，用来唯一地标识这个会话（`--session` 参数用它）。

## 3. 一棵树：id 和 parentId

### 3.1 为什么每条记录都指向上一条？

看起来多此一举：文件里的记录本来就是按顺序排列的。但是 `parentId` 让我们能做一件事：**回到过去，从某个地方重新开始，而不删除任何东西。**

```
问题 1 ── 回答 1 ──┬── 问题 2（问错了）── 回答 2
                   │
                   └── 问题 2（重新问）── ……    ← 当前位置
```

`SessionManager` 记着一个"当前位置"（`leafId`，叶子）。新的记录总是接在当前位置后面：

```ts
appendMessage(message: Message): string {
	return this.append({ type: "message", id: this.newId(), parentId: this.leafId, timestamp: now(), message });
}

private append(entry: SessionEntry): string {
	this.entries.push(entry);
	this.byId.set(entry.id, entry);
	this.leafId = entry.id;      // 新记录成为当前位置
	this.persist(entry);
	return entry.id;
}
```

`branch(entryId)` 把当前位置移回到之前的某条记录。之后的新记录的 `parentId` 指向那里，于是长出了一个新的分支。文件仍然只是追加，"问错了"的那两条还在文件里，随时可以回去看。

### 3.2 从当前位置恢复对话

要恢复对话，就从当前位置沿着 `parentId` 一路往回走，走到第一条记录，得到一条路径：

```ts
getBranch(): SessionEntry[] {
	const path: SessionEntry[] = [];
	let id = this.leafId;
	while (id !== null) {
		const entry = this.byId.get(id);
		if (!entry) break;
		path.unshift(entry);       // 加在前面：最早的在最前
		id = entry.parentId;
	}
	return path;
}

buildContext(): SessionContext {
	const context: SessionContext = { messages: [] };
	for (const entry of this.getBranch()) {
		if (entry.type === "message") context.messages.push(entry.message);
		else context.model = { provider: entry.provider, modelId: entry.modelId };   // 后面的覆盖前面的
	}
	return context;
}
```

`byId` 是一个 `Map`，用 id 找记录只要一步，而不用每次都在数组里从头找。

打开一个会话文件时，当前位置是文件里**最后一条**记录。

这一章我们只在测试里用到 `branch`（见 `test/session.test.ts`）。练习 3 会用它实现一个 `/undo` 命令。pi 的 `/tree` 命令可以在这棵树上任意跳转。

## 4. 可靠地写文件

### 4.1 只有真正开始对话时才创建文件

```ts
private persist(entry: SessionEntry): void {
	if (!this.file) return;                // 不保存的会话（--no-session）
	if (!this.flushed) {
		// 只有设置、还没有对话的会话不创建文件：打开程序又马上关掉，不会留下一个空的会话
		const hasConversation = this.entries.some((item) => item.type === "message");
		if (!hasConversation) return;
		mkdirSync(this.sessionDir, { recursive: true });
		const fd = openSync(this.file, "wx"); // wx：文件已存在时报错，绝不覆盖别的会话
		try {
			for (const item of [this.header, ...this.entries]) writeSync(fd, `${JSON.stringify(item)}\n`);
		} finally {
			closeSync(fd);
		}
		this.flushed = true;
	} else {
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
	}
}
```

启动程序时会先记录一条 `model_change`。如果用户什么都没说就退出了，我们不希望留下一个只有设置的空会话（`mini-pi -c` 会打开它，莫名其妙）。所以第一条消息出现之前，记录只存在内存里；第一条消息出现时，把文件头和之前的记录一次写进去。

打开文件时用的 `"wx"` 标志：`w` 是写，`x` 是"文件必须不存在"。万一两个会话的文件名相同（几乎不可能，但万一），宁可报错，也不覆盖别人的会话。

### 4.2 为什么用同步的写法？

`appendFileSync` 是同步的：写完才返回。我们在别的地方都用异步的写法，这里为什么不？

- **顺序**：消息必须按顺序写进文件。同步写法天然保证了顺序；异步的话，两次写入可能交错。
- **可靠**：函数返回时数据已经交给了操作系统。如果用户紧接着按了 Ctrl+C 退出，消息也不会丢。
- **够快**：每条消息只写一行，几毫秒的事，不会让界面卡顿。

pi 也是用同步的写法保存会话的。

### 4.3 读到坏掉的数据

程序可能在写最后一行的时候崩溃，留下半行 JSON：

```
{"type":"message","id":"880dd1e6",……}
{"type":"message","id":"39637d1b","parentId":
```

读文件时，解析不了的行直接跳过：

```ts
export function parseSessionFile(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// 跳过坏掉的行
		}
	}
	return entries;
}
```

丢掉最后半条消息，总比因为它而打不开整个会话强。这就是 JSONL 的好处：坏掉的只有那一行。

## 5. AgentSession：把 agent 和会话粘在一起

### 5.1 在 message_end 时保存

[code/src/core/agent-session.ts](code/src/core/agent-session.ts)：

```ts
export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;

	constructor(agent: Agent, sessionManager: SessionManager) {
		this.agent = agent;
		this.sessionManager = sessionManager;

		// 恢复之前的对话
		agent.state.messages = sessionManager.buildContext().messages;
		this.recordModel();

		// 每条消息完成时，追加到会话文件。这是 agent 的第一个订阅者，所以在界面显示之前就已经保存了
		agent.subscribe((event) => {
			if (event.type === "message_end") sessionManager.appendMessage(event.message);
		});
	}
	// ……
}
```

就这么几行。里程碑 10 说过："里程碑 14 保存会话时也会这样做：每收到一个 `message_end`，就往文件里追加一行。"现在兑现了。事件设计的好处又一次体现出来：保存会话不需要改动 agent 的任何代码，订阅一下就行。

用户消息、模型的回复、工具结果、插话和排队的消息，都会发出 `message_end`，所以都会被保存。出错或被取消的回复也会被保存（`stopReason` 是 `error` 或 `aborted`）。恢复之后，里程碑 08 的 `transformMessages` 会跳过它们，不发给模型。

如果程序在工具执行到一半时崩溃了呢？带着工具调用的助手消息已经保存了，工具结果还没有。恢复之后，`transformMessages` 会给这些"孤立"的工具调用补上一个错误结果。里程碑 08 埋下的两道保险，在这里派上了用场。

### 5.2 中间层

为什么要多一个 `AgentSession` 类，而不是让各个模式直接使用 `Agent` 和 `SessionManager`？

```
print 模式 ─┐                         ┌─ Agent（对话、循环、事件）
            ├─→  AgentSession  ──────┤
交互模式 ───┘   （会话相关的逻辑）     └─ SessionManager（文件）
```

"换模型时记录一下"、"开始新会话时既要清空 agent 又要换文件"、"统计这次会话用了多少 token"……这些逻辑和具体的模式无关。放在 `AgentSession` 里，print 模式和交互模式（以及将来的全屏界面）都能用，不用各写一遍。下一章的上下文压缩也会放在这里。

pi 的 `AgentSession`（`packages/coding-agent/src/core/agent-session.ts`）有四千多行，是整个 coding agent 的核心：自动重试、上下文压缩、扩展、分支……都在里面。我们的只有几十行，但位置和作用是一样的。

两个模式的改动很小：参数从 `Agent` 换成了 `AgentSession`，发送消息用 `session.prompt()`，订阅事件、读取状态用 `session.agent`。

### 5.3 记录模型

```ts
/** 当前的模型和会话里记录的不一样时，追加一条 model_change */
private recordModel(): void {
	const recorded = this.sessionManager.buildContext().model;
	const { provider, id } = this.agent.state.model;
	if (recorded?.provider !== provider || recorded.modelId !== id) {
		this.sessionManager.appendModelChange(provider, id);
	}
}
```

新会话开始时、恢复会话但用 `--model` 换了模型时、调用 `setModel` 时，都会记录。`cli.ts` 选择模型的顺序是：命令行参数 → 会话里记录的模型 → 环境变量 `MINI_PI_MODEL`。

## 6. 命令行参数

[code/src/cli.ts](code/src/cli.ts) 的 `openSession` 根据参数决定用哪个会话：

```ts
async function openSession(args: CliArgs, cwd: string, sessionDir: string): Promise<SessionManager | undefined> {
	if (args.noSession) return SessionManager.inMemory(cwd);
	if (args.session) {
		const path = existsSync(args.session) ? args.session : SessionManager.findById(sessionDir, args.session);
		if (!path) throw new Error(`找不到会话：${args.session}`);
		return SessionManager.open(path);
	}
	if (args.continue) return SessionManager.continueRecent(cwd, sessionDir);
	if (args.resume) {
		const path = await pickSession(sessionDir);
		return path ? SessionManager.open(path) : undefined;
	}
	return SessionManager.create(cwd, sessionDir);
}
```

| 参数 | 作用 |
| --- | --- |
| （没有参数） | 新建一个会话 |
| `-c`, `--continue` | 继续这个目录里最近修改的会话（没有的话新建一个） |
| `-r`, `--resume` | 列出这个目录的会话，输入编号选一个 |
| `--session <文件或 id>` | 打开指定的会话。id 只写开头几个字符就行 |
| `--no-session` | 不保存（适合在脚本里临时问一个问题） |

`--resume` 列出的会话以第一条用户消息作为标题：

```
 1. 2026/10/12 23:14:50  8 条消息  我在重构登录模块，先帮我看看 src/auth.ts
 2. 2026/10/11 15:02:13  23 条消息  测试挂了，帮我看看
选择要继续的会话（输入编号，直接回车取消）：1
```

`SessionManager.list` 为了拿到标题和消息数，要把每个会话文件都读一遍。会话很多、文件很大时会慢（pi 为此做了不少优化，比如只读文件的开头）。对我们来说，先简单地做。

恢复会话后，交互模式会把之前的对话简单地显示一遍（`formatHistory`），让你想起来聊到哪了。退出时显示这次会话的统计，以及下次怎样继续。

print 模式也能用会话：

```bash
mini-pi -p "分析一下 src 目录的结构"
mini-pi -c -p "根据刚才的分析，哪个模块最需要重构？"
```

## 7. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/core/session.ts` | `SessionHeader`、`MessageEntry`、`ModelChangeEntry`、`SessionEntry`、`SessionContext`、`SessionInfo`、`getSessionDir(agentDir, cwd)`、`parseSessionFile(content)`、`SessionManager`（`create`、`open`、`continueRecent`、`inMemory`、`list`、`findById`；`appendMessage`、`appendModelChange`、`getBranch`、`buildContext`、`branch`、`newSession`、`getEntries`；`sessionId`、`sessionFile`、`cwd`） |
| `src/core/agent-session.ts` | `AgentSession`（`agent`、`sessionManager`、`prompt`、`setModel`、`newSession`、`getStats`）、`SessionStats` |
| `src/modes/print.ts`、`repl.ts` | 参数从 `Agent` 换成 `AgentSession`；`repl.ts` 新增 `formatHistory` |
| `src/cli/args.ts` | 新增 `continue`、`resume`、`session`、`noSession` |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `session.test.ts`（9 个测试）和 `agent-session.test.ts`（4 个测试），`cli.test.ts` 新增了 3 个端到端测试（`--continue`、`--no-session`、`--session`），`repl.test.ts` 改用 `AgentSession`。一共 213 个测试。

`agent-session.test.ts` 里有一个测试模拟了"关掉程序、明天再打开"：

```ts
// 模拟"关掉程序、明天再打开"：新的 Agent，新的 SessionManager，打开同一个文件
const second = createFauxModel([{ text: "你叫小明" }]);
const session2 = new AgentSession(
	new Agent({ model: second.model }),
	SessionManager.open(session1.sessionManager.sessionFile as string),
);
assert.equal(session2.agent.state.messages.length, 2);
await session2.prompt("我叫什么？");
assert.equal(second.requests[0].messages.length, 3, "第二天的请求里有昨天的两条消息");
```

## 8. 常见错误

| 现象 | 原因 |
| --- | --- |
| 每条消息在文件里出现了两次 | 既在 `message_end` 时保存，又在 `prompt` 结束后把所有新消息保存了一遍 |
| 打开程序又马上关掉，`-c` 却打开了一个空会话 | 没有对话时也创建了文件 |
| 一个会话文件坏了最后一行，整个会话都打不开 | 解析时没有跳过坏掉的行 |
| `-c` 打开了另一个项目的会话 | 所有项目的会话放在了同一个文件夹里 |
| 恢复会话后，模型说"我不知道你在说什么" | 恢复的消息没有放进 `agent.state.messages`，或者是在 `AgentSession` 创建之后才放的 |
| 恢复后第一次请求就报 400 错误（工具调用缺少结果） | 程序曾在工具执行时崩溃。检查 `transformMessages` 是不是还在适配器里调用 |
| 换了模型，下次 `-c` 又变回了旧模型 | 换模型时没有记录 `model_change`，或者恢复时没有读取它 |

## 9. 练习

1. **`/sessions` 风格的列表**：给 `mini-pi` 加一个参数 `--list-sessions`，列出当前目录的所有会话（时间、消息数、标题、id 的前 8 位），然后退出。
2. **会话名字**：pi 可以用 `/name` 给会话起名字，`-r` 列表里显示名字而不是第一条消息。加一种新的记录 `{ type: "session_info", name }`，`list` 时如果有名字就用名字。在交互模式里，输入 `/name 重构登录` 设置名字。（提示：在 `repl.ts` 的 `rl.on("line")` 里先判断是不是以 `/name ` 开头。）
3. **撤销**：在交互模式里输入 `/undo`，回到最后一条用户消息之前：找到当前路径上最后一条用户消息，把当前位置移到它的 `parentId`（用 `branch`），然后把 `agent.state.messages` 换成新的 `buildContext().messages`。被撤销的对话仍然在文件里。
4. **导出**：加一个参数 `--export <会话文件> <输出.md>`，把会话导出成 Markdown：用户消息是引用块，回复是正文，工具调用是代码块。（pi 可以把会话导出成 HTML。）
5. **思考题**：两个终端同时在同一个目录里运行 `mini-pi -c`，会发生什么？两个进程往同一个文件里追加内容，文件会坏吗？（提示：`appendFileSync` 每次写一整行；想一想 `parentId` 会变成什么样。）

## 10. 自测问题

1. 为什么用 JSONL 而不是一个大的 JSON 数组？
2. `parentId` 有什么用？"当前位置"是什么？
3. 为什么要等到第一条消息出现才创建会话文件？
4. 保存会话为什么用同步的 `appendFileSync`？
5. 读会话文件时遇到解析不了的行，为什么跳过而不是报错？
6. 消息是在什么时候被保存的？为什么不需要修改 agent 的代码？
7. 程序在执行工具时崩溃了，恢复会话后为什么不会因为"工具调用缺少结果"而出错？
8. `AgentSession` 解决了什么问题？

<details>
<summary>参考答案</summary>

1. JSONL 只需要在文件末尾追加一行，不用重写整个文件；写到一半崩溃时最多坏掉最后一行；可以一行一行地读，也方便用 `tail`、`grep` 查看。
2. 每条记录指向它的上一条，记录就连成了一棵树。"当前位置"（叶子）是最新的那条记录，新记录接在它后面。把当前位置移回之前的某条记录，就能从那里重新开始，而不删除任何东西。
3. 避免打开程序又马上关掉时留下只有设置、没有对话的空会话。
4. 保证写入的顺序；函数返回时数据已经交给操作系统，紧接着退出也不会丢；每次只写一行，足够快。
5. 程序崩溃可能留下半行数据。跳过它只丢掉最后半条消息，报错的话整个会话都打不开了。
6. 在 `message_end` 事件里保存。`AgentSession` 订阅 agent 的事件就行，agent 本身完全不知道有会话这回事。
7. 发给模型之前，`transformMessages` 会给没有结果的工具调用补上一个错误结果。
8. 把会话相关的逻辑（恢复、保存、记录模型、新会话、统计）集中在一个地方，各种模式都通过它使用 agent，不用各写一遍。

</details>

## 11. 对照 pi 源码

- **格式**：[docs/session-format.md](../../packages/coding-agent/docs/session-format.md) 完整地描述了 pi 的会话格式。对照着看：文件头（`"type":"session"`、`version`、`cwd`）、每条记录的 `id`/`parentId`（"Usually an 8-char hex ID"）、`model_change`、存放位置（`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`）——和我们的几乎一样。pi 还有更多种记录：`compaction`（下一章）、`branch_summary`（切换分支时对旧分支的总结）、`label`（书签）、`session_info`（会话名字）、`custom`（扩展的数据）……文档的 "Tree Structure" 和 "Context Building" 两节讲了怎样从这棵树恢复上下文。
- **[session-manager.ts](../../packages/coding-agent/src/core/session-manager.ts)**：
  - `getDefaultSessionDirPath`：`--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`，和我们的一字不差；
  - `newSession`：文件名是 `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`；
  - `_persist`：读读它上面的注释。"打开又关掉 pi，不留下文件"、用 `"wx"` 创建文件、之后用 `appendFileSync` 追加——都和我们一样。注释里还提到为什么从用户消息（而不是第一条回复）开始就创建文件：如果第一轮对话没有完成，用户的问题也不会丢；
  - `generateId`：`randomUUID().slice(0, 8)`，检查重复；
  - `parseSessionEntryLine`：解析失败返回 `null`，跳过坏掉的行；
  - `findMostRecentSession`、`continueRecent`、`list`：对应我们的同名方法；
  - `migrateV1ToV2` 等函数：读到旧版本的文件时自动升级到新格式。版本号就是为这个准备的。
- **[agent-session.ts](../../packages/coding-agent/src/core/agent-session.ts)**：搜索 `Handle session persistence`，你会看到 `if (event.type === "message_end")` 后面调用了 `this.sessionManager.appendMessage(event.message)`。pi 还会在系统提示词或工具变化时保存一条系统消息，这样恢复会话时用的是当时的提示词。我们每次启动都重新生成系统提示词，更简单。
- **会话选择器**：pi 的 `-r` 打开一个全屏的选择界面（`cli/session-picker.ts` 调用的 `modes/interactive/components/session-selector.ts`），可以输入文字搜索（`session-selector-search.ts`），也可以按 Ctrl+D 删除会话。我们先用输入编号的方式，学完界面之后可以做得更好。

## 12. 闭卷挑战

不看资料，写出：

1. `SessionManager` 的 `appendMessage`、`persist`（包括延迟创建文件）、`getBranch`、`buildContext`、`list`；
2. `AgentSession` 的构造函数（恢复、订阅、保存）。

让 `test/session.test.ts` 和 `test/agent-session.test.ts` 全部通过。

---

上一步：[里程碑 13：系统提示词与命令行](../13-system-prompt/README.md) · 下一步：[里程碑 15：上下文压缩](../15-compaction/README.md)
