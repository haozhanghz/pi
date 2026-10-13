# 里程碑 19：交互模式

> 目标：把前面所有的零件装起来——agent、会话、上下文压缩、终端界面——做出 mini-pi 真正的交互界面：对话记录、流式输出的回答、实时更新的命令输出、随时可以打断、运行中可以插话。
>
> 完成后你将拥有：`src/modes/interactive/`（交互模式和五个组件）。直接运行 `mini-pi` 就进入这个界面；原来的逐行模式保留下来，用 `--plain` 启动。

```
$ mini-pi

 mini-pi 0.7.0
 已加载 ~/project/AGENTS.md
 Esc 打断 · Ctrl+C 清空输入，按两次退出 · Ctrl+D 退出 · 运行时
 回车是插话，+ 开头是排队 · /compact /new /quit

 > 写入 a.txt 内容 你好 然后 运行 cat a.txt

 我来写入 a.txt。

 write a.txt
 │ 已写入 1 行

 我来运行 cat a.txt。

 $ cat a.txt
 │ 你好

 ⠹ 正在思考……（Esc 打断）

────────────────────────────────────────────────────────────────
 █
────────────────────────────────────────────────────────────────
 ~/project · fake-model · ↑4.1k ↓80 · $0.000 · 上下文 1%
```

## 你将学到

- 界面和 agent 怎样分工：用事件驱动界面
- 每一种事件对应界面上的什么变化
- 流式输出的消息、实时更新的命令输出怎样显示
- 为什么命令的输出要先"清理"再显示
- 用户的操作怎样变成对 agent 的操作：提交、插话、排队、打断、退出
- 用一个 Promise 把"运行中弹出确认对话框"接起来
- 恢复会话时怎样重建界面
- 怎样自动测试一个交互式程序

---

## 1. 问题：把零件装起来

到现在为止，我们有了：

- `AgentSession`（里程碑 14、15）：发送消息、保存会话、压缩上下文，过程中发出一个个**事件**；
- 终端界面框架（里程碑 16~18）：组件、差分渲染、输入框、Markdown。

里程碑 13 的逐行模式（`repl.ts`）只是把事件打印出来。现在要做的，是一个"胶水层"：

- **agent → 界面**：把每个事件变成界面上的变化。来了一段文字，就更新正在输出的回答；开始执行一个工具，就在对话里加一个工具的组件……
- **用户 → agent**：把用户的输入和按键变成对 agent 的操作。按回车是发送（运行中是插话），按 Esc 是打断……

pi 的 `interactive-mode.ts` 有七千多行，因为它支持的功能非常多。核心的结构只有这两个方向，我们用四百行实现它。

## 2. 界面的结构

```
TUI
├── Spacer
├── 标题          Text：名字、版本、已加载的 AGENTS.md、快捷键提示
├── chat          Container：对话记录（用户消息、助手消息、工具调用、提示）
├── pending       Container：排队等待的插话
├── status        Container："正在工作"的动画
├── Spacer
├── editorArea    Container：输入框（确认对话框会临时替换它）
└── footer        状态栏：目录、模型、token、费用、上下文
```

为什么 `pending`、`status`、`editorArea` 都是单独的容器？因为它们的内容会**整个换掉**：动画出现又消失，排队的消息被取走，输入框临时换成对话框。用一个容器占住位置，换内容时只要 `clear()` 再 `addChild()`，不影响上下其他部分的位置。

`chat` 只会往后加东西（或者整个清空），对话越长，它越长。上面的部分滚进终端的历史记录，差分渲染只重画最下面变化的几行——这正是里程碑 17 那套设计的用武之地。

## 3. agent → 界面：处理事件

`InteractiveMode` 订阅 `AgentSession` 的事件，每一种事件对应界面上的一种变化：

| 事件 | 界面的变化 |
| --- | --- |
| `agent_start` | 显示"正在思考……"的动画 |
| `message_start`（用户） | 在对话里加一条用户消息；更新排队区 |
| `message_start`（助手） | 新建一个助手消息组件，加到对话里 |
| `message_update` | 用最新的内容更新这个助手消息 |
| `message_end`（助手） | 最后更新一次；更新状态栏的 token 和费用 |
| `tool_execution_start` | 新建一个工具组件，按工具调用的 id 记下来；动画改成"正在执行 bash……" |
| `tool_execution_update` | 更新这个工具的部分结果（bash 的实时输出） |
| `tool_execution_end` | 显示最终的结果 |
| `agent_end` | 隐藏动画；更新状态栏 |
| `compaction_start` / `compaction_end` | 显示"正在压缩上下文……"；完成后在对话里加一行说明 |

```ts
private readonly handleEvent = (event: AgentSessionEvent): void => {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "user") {
				this.chat.addChild(this.createUserMessage(event.message.content));
				this.updatePending(); // 排队的消息可能刚被取走
			} else if (event.message.role === "assistant") {
				this.streaming = new AssistantMessageView(event.message);
				this.chat.addChild(this.streaming);
			}
			break;
		case "message_update":
			this.streaming?.update(event.message);
			break;
		case "tool_execution_start": {
			const view = new ToolExecutionView(event.toolName, event.args);
			this.runningTools.set(event.toolCallId, view);
			this.chat.addChild(view);
			this.showLoader(`正在执行 ${event.toolName}……`);
			break;
		}
		// ……
	}
	this.tui.requestRender();
};
```

几个值得注意的地方：

**用户的消息在 `message_start` 时才显示，而不是用户按回车的时候。** 为什么？想想插话：agent 正在执行工具，用户输入"顺便看看测试"按回车。这条消息要等工具执行完才真正交给模型。如果按回车时就显示在对话里，它会出现在工具的结果**上面**，而模型其实是在看到工具结果**之后**才看到它的。等 agent 真正取走它（发出 `message_start`）时再显示，对话记录的顺序就和模型看到的顺序一致。在那之前，它显示在输入框上方的排队区里。

**工具组件用 `Map` 按 id 记录。** 模型可以一次调用好几个工具，它们并行执行（里程碑 10），`tool_execution_update` 和 `tool_execution_end` 的顺序是乱的，只能按 `toolCallId` 找到对应的组件。

**每个事件之后都请求重画。** `requestRender` 会把同一时刻的请求合并起来（里程碑 17），所以不用担心模型一秒送来几百个片段。

> 另一种做法是不记录组件，每一帧都根据 `agent.state.messages` 重新生成整个界面——"界面是状态的函数"。对话记录只会往后追加，增量地添加组件更自然：旧的组件一直保留着，它们的渲染缓存也一直有效。

## 4. 组件

### 4.1 助手消息：流式更新

`AssistantMessageView` 是一个容器。每次 `update(message)` 都**清空重建**：文字用 `Markdown`，思考过程用灰色斜体的 `Text`；最后根据 `stopReason` 加一行说明（出错了、已打断、被截断了）。

```ts
update(message: AssistantMessage): void {
	this.clear();
	for (const block of message.content) {
		if (block.type === "thinking" && block.thinking.trim() !== "") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(gray(italic(block.thinking.trim()))));
		} else if (block.type === "text" && block.text.trim() !== "") {
			this.addChild(new Spacer(1));
			this.addChild(new Markdown(block.text.trim()));
		}
	}
	if (message.stopReason === "error") this.addNotice(red(`出错了：${message.errorMessage ?? "未知错误"}`));
	// ……
}
```

每收到一个片段就新建 `Markdown` 组件，会不会太浪费？新建对象很便宜，真正花时间的是解析和换行，而它们只在渲染时发生，一秒最多 60 次。消息完成之后就不再更新，它的 `Markdown` 组件会一直用缓存。

工具调用不在助手消息里显示：它们由单独的 `ToolExecutionView` 显示，因为它要显示**执行的结果**，而结果是后来才有的。

### 4.2 工具调用：概要和预览

第一行是工具和参数的**概要**，下面几行是结果的**预览**，每行前面一条灰色的竖线：

| 工具 | 第一行 | 预览 |
| --- | --- | --- |
| `bash` | `$ npm test` | 输出的**最后** 5 行（测试结果、报错通常在最后） |
| `read` | `read src/utils.ts` | 文件的前 3 行 |
| `edit` | `edit src/utils.ts` | 带颜色的 diff（最多 20 行） |
| `write` | `write test/a.test.ts` | "已写入 31 行" |
| 其他 | 工具名和 JSON 参数 | 输出的前 5 行 |
| 出错时 | 同上 | 错误信息，红色 |

工具还在运行时，第一行后面显示"运行中……"。bash 命令的输出通过 `tool_execution_update` 实时送来（里程碑 12 的 `onUpdate`，每 100 毫秒一次），预览跟着更新。

输出的每一行是**截断**而不是折行：预览的高度固定，不会因为某一行特别长而占满整个屏幕。

`ToolExecutionView` 的缓存用一个版本号判断是否有效：每次内容改变 `version++`，渲染时版本号和宽度都没变就用缓存。

### 4.3 清理命令的输出

命令的输出不能原样显示。想想 `npm install` 的输出里有什么：

- **颜色和光标控制序列**：颜色还好，可如果输出里有"光标上移三行"，它会直接作用在我们的界面上，把画面搞乱。差分渲染的前提是"框架知道屏幕上是什么"，任何绕过框架的输出都会破坏它。
- **回车符 `\r`**：进度条用它回到行首、在原地刷新。`下载 10%\r下载 50%\r下载 100%` 在终端里最后显示的只是`下载 100%`。
- **制表符**：在终端里的宽度不确定。

所以显示之前先清理：

```ts
export function sanitizeOutput(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) =>
			line
				.slice(line.lastIndexOf("\r") + 1) // 只保留最后一个 \r 后面的内容
				.replaceAll("\t", "   ")
				.replace(/[\x00-\x1f\x7f]/g, ""),
		)
		.join("\n");
}
```

先把 Windows 的换行 `\r\n` 换成 `\n`，否则每一行末尾的 `\r` 会让整行被当作"回到行首"而清空。

### 4.4 其他组件

- **`UserMessageView`**：前面一个青色的 `>`，折行后的行和文字对齐。
- **`Footer`**：目录、模型、输入和输出的 token、费用、上下文用了百分之几。统计要遍历整个会话，所以只在消息完成、压缩完成时调用 `footer.update()` 重新计算，而不是每次渲染都算一遍。
- **`ConfirmDialog`**：见第 6 节。

## 5. 用户 → agent：处理输入

### 5.1 提交

```ts
private submit(text: string): void {
	if (text === "") return;
	this.editor.addToHistory(text);
	if (text === "/quit") {
		void this.exit();
	} else if (text === "/new") {
		this.newSession();
	} else if (text === "/compact" || text.startsWith("/compact ")) {
		void this.compact(text.slice("/compact".length).trim() || undefined);
	} else if (this.busy) {
		// 正在运行：普通的消息是插话，以 + 开头的是排队
		if (text.startsWith("+")) this.session.agent.followUp(text.slice(1).trim());
		else this.session.agent.steer(text);
		this.updatePending();
	} else {
		void this.prompt(text);
	}
}
```

插话和排队的区别（里程碑 10）：插话在当前这一步完成后马上交给模型，排队要等 agent 本来要停下时才处理。pi 用 Alt+Enter 排队，我们的 Alt+Enter 已经用来换行了，所以沿用逐行模式的 `+` 开头。

`prompt` 里有一个容易忽略的情况：

```ts
private async prompt(text: string): Promise<void> {
	this.busy = true;
	let next: string | undefined = text;
	while (next !== undefined && !this.exiting) {
		try {
			await this.session.prompt(next);
		} catch (error) {
			this.addNotice(red(`程序出错：${error instanceof Error ? error.message : String(error)}`));
		}
		// agent 快结束的时候才插话的消息，可能没赶上这一次运行：接着处理，不能丢掉
		const { steering, followUp } = this.session.agent.queuedMessages;
		const leftover = [...steering, ...followUp].map(textOf);
		this.session.agent.clearQueues();
		next = leftover.length > 0 ? leftover.join("\n\n") : undefined;
	}
	this.busy = false;
	// ……
}
```

agent loop 在最后一次检查插话队列之后、发出 `agent_end` 之前，还有一小段时间。用户恰好在这时按回车，消息就留在队列里没人处理了。所以运行结束后再检查一次队列，有剩下的就接着发。

注意这里用的是自己的 `busy`，而不是 `agent.state.isStreaming`：发送消息之前可能先要压缩上下文，那时 agent 还没开始运行，但我们已经在忙了。

### 5.2 全局快捷键

有些按键不管焦点在哪个组件上都要有效：Esc 打断、Ctrl+C、Ctrl+D。它们用 `tui.addInputListener` 注册，比输入框先收到按键（里程碑 17）。和编辑器一样，按键写在快捷键表里：

```ts
"app.interrupt": ["escape"],
"app.clear": ["ctrl+c"],
"app.exit": ["ctrl+d"],
```

```ts
private readonly handleKey = (data: string): boolean => {
	if (matchesAction(data, "app.interrupt") && this.busy) {
		this.interrupt();
		return true;
	}
	if (matchesAction(data, "app.clear")) {
		const now = Date.now();
		if (now - this.lastCtrlC < DOUBLE_PRESS_MS) void this.exit();
		else this.editor.setText("");
		this.lastCtrlC = now;
		return true;
	}
	if (matchesAction(data, "app.exit") && this.editor.getText() === "") {
		void this.exit();
		return true;
	}
	return false; // 其他按键交给输入框
};
```

- **Esc 只在忙的时候拦截**，空闲时交给输入框（以后输入框可能会用到它）。
- **Ctrl+C 按一次清空输入框，半秒内再按一次退出**。按一次就退出太容易误操作了；很多终端程序（包括 pi）都是这样设计的。
- **Ctrl+D 只在输入框为空时退出**，否则它是编辑器的"删除光标后面的字"。

### 5.3 打断

```ts
private interrupt(): void {
	const agent = this.session.agent;
	const { steering, followUp } = agent.queuedMessages;
	const queued = [...steering, ...followUp].map(textOf);
	agent.clearQueues();
	if (queued.length > 0) {
		this.editor.setText([...queued, this.editor.getText()].filter((text) => text !== "").join("\n\n"));
	}
	agent.abort();
	this.updatePending();
}
```

打断时，还在排队的消息放回输入框，而不是直接丢掉——用户打的字，不应该因为按了一下 Esc 就没了。pi 也是这样做的。

### 5.4 退出

退出的顺序很重要：取消运行 → **等 agent 真正停下**（`waitForIdle`，被取消的消息也会保存到会话文件）→ 停止界面、恢复终端 → 打印本次会话的统计。

## 6. 运行中的确认对话框

里程碑 12 给 agent 加了 `beforeToolCall`：执行工具之前先问一下。逐行模式里是打印一个问题、等下一行输入。在全屏界面里，我们把输入框**临时换成一个对话框**：

```ts
private ask(title: string, detail: string, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		const answer = (allowed: boolean) => {
			signal?.removeEventListener("abort", onAbort);
			this.editorArea.clear();
			this.editorArea.addChild(this.editor); // 换回输入框
			this.tui.setFocus(this.editor);
			resolve(allowed);
		};
		const onAbort = () => answer(false); // 运行被打断：当作拒绝
		signal?.addEventListener("abort", onAbort, { once: true });
		const dialog = new ConfirmDialog(title, detail, answer);
		this.editorArea.clear();
		this.editorArea.addChild(dialog);
		this.tui.setFocus(dialog);
		this.tui.requestRender();
	});
}
```

整个过程是 agent 和界面通过一个 **Promise** 握手：

```
agent loop                          界面
──────────                          ────
准备执行 bash "rm -rf build"
调用 beforeToolCall
  └─ await ask(……) ───────────────→ 输入框换成对话框，等待按键
     （agent 停在这里）                 ……
                                    用户按 y
  ←──────────────── resolve(true) ── 换回输入框
继续执行 bash
```

agent 不知道界面长什么样，界面也不知道 agent loop 的细节；它们之间只有一个 `Promise<boolean>`。逐行模式、交互模式、以后可能有的网页界面，都可以用自己的方式回答这个问题。

对话框按 y 允许，按 n 或 Esc 拒绝。这两个按键同样写在快捷键表里（`dialog.allow`、`dialog.deny`），对话框底部的提示用 `getKeys` 读出当前的按键显示出来。危险命令的识别从 `repl.ts` 搬到了 `src/core/dangerous.ts`，两种模式共用。

## 7. 恢复会话

用 `mini-pi -c` 继续上次的会话时，要把之前的对话显示出来。消息的顺序是"助手消息（包含工具调用）→ 工具结果 → 工具结果 → ……"，按 id 把结果配对到工具组件上：

```ts
private renderHistory(messages: Message[]): void {
	const tools = new Map<string, ToolExecutionView>();
	for (const message of messages) {
		if (message.role === "user") {
			this.chat.addChild(this.createUserMessage(message.content));
		} else if (message.role === "assistant") {
			this.chat.addChild(new AssistantMessageView(message));
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const view = new ToolExecutionView(block.name, block.arguments);
				tools.set(block.id, view);
				this.chat.addChild(view);
			}
		} else {
			tools.get(message.toolCallId)?.setResult({ content: message.content, details: message.details }, message.isError);
			tools.delete(message.toolCallId);
		}
	}
	// 没有结果的工具调用：上次运行时被打断了
	for (const view of tools.values()) view.setResult({ content: [{ type: "text", text: "没有执行（被打断了）" }] }, true);
}
```

压缩之后的总结也是一条用户消息（里程碑 15），显示成一行灰色的"（更早的对话已经压缩成了一份总结）"。

## 8. 测试交互模式

交互式的程序怎么自动测试？我们已经有了所有需要的零件：

- **假终端** `VirtualTerminal`（里程碑 17）：`send()` 模拟按键，`getAllLines()` 读出屏幕和历史记录上的文字；
- **假模型** `createFauxModel`（里程碑 07）：按剧本回复，可以调用工具；
- **只在内存里的会话** `SessionManager.inMemory`（里程碑 14）。

`runInteractiveMode` 接受一个 `terminal` 选项，测试时传入假终端：

```ts
test("危险的命令：弹出确认对话框，按 n 拒绝之后不会执行", async () => {
	const commands: string[] = [];
	const { faux, terminal, done, screen } = setup(
		[{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "好的，不删了" }],
		[fakeBash(commands)],
	);
	terminal.send("清理一下\r");
	await waitFor(() => screen().includes("允许执行吗"), "确认对话框");
	terminal.send("n");
	await waitFor(() => screen().includes("好的，不删了"), "拒绝之后的回答");
	assert.deepEqual(commands, [], "命令没有执行");
	terminal.send("\x04");
	await done;
});
```

事情都是异步发生的：按下回车之后，agent 要运行、事件要处理、界面要等下一帧才渲染。所以测试用 `waitFor` **轮询**：每 10 毫秒检查一次屏幕，直到条件成立，超过 3 秒就报错。不要用"等 500 毫秒再检查"——机器忙的时候 500 毫秒可能不够，测试就会时好时坏；条件一成立就继续，又不浪费时间。

## 9. 运行

先启动假模型服务器（另一个终端窗口里）：

```bash
node learn/tools/fake-llm/server.ts
```

然后在一个空目录里运行（`--no-session` 不保存会话）：

```bash
mkdir -p /tmp/play && cd /tmp/play
node ~/my-pi/src/cli.ts --no-session
```

试试这些：

1. `写入 a.txt 内容 你好 然后 运行 cat a.txt`：看工具一个接一个地出现。
2. `运行 rm -rf build`：弹出确认对话框，按 y 或 n。
3. `运行 sleep 5 然后 运行 echo 完成`，在 sleep 运行的时候输入一句话按回车：它先出现在输入框上方的排队区，sleep 结束后才出现在对话里。再试试按 Esc 打断。
4. 一直聊到内容超过一屏，用鼠标滚轮往上翻；拖动窗口改变宽度。
5. 去掉 `--no-session`，聊几句后退出，再用 `-c` 继续：之前的对话都显示出来了。
6. `node ~/my-pi/src/cli.ts --plain`：回到逐行模式。

用真正的模型时（见里程碑 03 和 07），工具调用、Markdown 渲染、思考过程的效果会好得多。

## 10. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/modes/interactive/interactive-mode.ts` | `runInteractiveMode(session, { terminal, cwd, confirmDangerous, initialMessages, contextFiles })` |
| `src/modes/interactive/components/assistant-message.ts` | `AssistantMessageView(message)`：`update(message)` |
| `src/modes/interactive/components/tool-execution.ts` | `ToolExecutionView(toolName, args)`：`setPartialResult`、`setResult(result, isError)`；`sanitizeOutput` |
| `src/modes/interactive/components/user-message.ts` | `UserMessageView(text)` |
| `src/modes/interactive/components/footer.ts` | `Footer(session, cwd)`：`update()`；`formatTokens`、`shortenPath` |
| `src/modes/interactive/components/confirm-dialog.ts` | `ConfirmDialog(title, detail, onAnswer)` |
| `src/core/dangerous.ts` | `DANGEROUS_PATTERNS`、`isDangerousCommand`（从 `repl.ts` 搬过来） |
| `src/tui/keybindings.ts` | 新增动作 `dialog.allow`、`dialog.deny`、`app.interrupt`、`app.clear`、`app.exit`；新增 `formatKeyId` |
| `src/core/agent-session.ts` | `SessionStats` 新增 `inputTokens`、`outputTokens` |
| `src/cli.ts`、`src/cli/args.ts` | 默认进入交互模式；`--plain` 或 `TERM=dumb` 时用逐行模式 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `interactive.test.ts`（7 个测试）和 `interactive-components.test.ts`（9 个测试），一共 322 个测试。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 插话的消息出现在工具结果的上面 | 在用户按回车时就把消息加到了对话里，应该等 `message_start` |
| 并行的工具，结果显示到了别的工具下面 | 用"最后一个工具组件"而不是按 `toolCallId` 查找 |
| 运行 `npm install` 之后界面乱了 | 命令输出里的控制序列、`\r` 没有清理 |
| 状态栏让界面越来越卡 | 每次渲染都遍历整个会话计算统计 |
| 按 Esc 之后，刚才排队的消息不见了 | 打断时没有把队列里的消息放回输入框 |
| 退出时会话文件里少了最后一条消息 | 没等 agent 真正停下（`waitForIdle`）就退出了 |
| 确认对话框关不掉，或者按 Esc 打断后对话框还在 | 没有监听 `signal` 的 abort 事件 |
| 测试时好时坏 | 用固定的等待时间，而不是轮询条件 |

## 12. 练习

1. **展开工具输出**：加一个快捷键（pi 是 Ctrl+O，动作名 `app.tools.expand`），切换"预览"和"完整输出"。提示：所有工具组件共用一个"是否展开"的开关，切换后要让它们的缓存失效。
2. **计时**：在工具的第一行后面显示它运行了多久，比如 `$ npm test（3.2 秒）`。
3. **等待确认**：弹出确认对话框时，动画的文字改成"等待你的确认……"，回答之后再改回来。
4. **折叠思考过程**：思考的内容默认只显示一行"思考中……"，按一个快捷键（pi 是 Ctrl+T）展开。
5. **`!` 命令**：输入以 `!` 开头的内容时，不发给模型，直接在本地执行这个命令并显示输出（pi 的 `!ls`）。想一想：命令的输出要不要放进对话，让模型看到？
6. **思考题**：`handleEvent` 收到 `message_update` 时，为什么不需要关心 `event.event` 具体是哪种片段（文字、思考、工具调用参数）？

## 13. 自测问题

1. 交互模式的"两个方向"分别是什么？
2. 为什么 `pending`、`status`、`editorArea` 要用单独的容器？
3. 用户的消息为什么在 `message_start` 时才加到对话里？
4. 为什么工具组件要按 `toolCallId` 记录？
5. 命令的输出为什么要先清理？`\r` 是怎么处理的？
6. 运行中按回车和以 `+` 开头有什么区别？运行快结束时插话的消息是怎么保证不丢的？
7. Ctrl+C、Ctrl+D、Esc 各自在什么情况下做什么？为什么 Ctrl+C 要按两次才退出？
8. 确认对话框是怎样和 agent loop 配合的？运行被打断时它怎么办？
9. 测试交互模式时，为什么用轮询而不是固定的等待时间？

<details>
<summary>参考答案</summary>

1. agent → 界面：把事件变成界面上的变化；用户 → agent：把输入和按键变成对 agent 的操作（发送、插话、打断……）。
2. 它们的内容会整个换掉（动画出现又消失，输入框换成对话框）。用容器占住位置，换内容时不影响其他部分。
3. 插话的消息要等 agent 真正取走才交给模型。等 `message_start` 时再显示，对话记录的顺序和模型看到的顺序一致。
4. 多个工具可以并行执行，它们的更新和结束事件交错到来，只能按 id 找到对应的组件。
5. 输出里的控制序列会直接作用在界面上，破坏差分渲染的前提；进度条用 `\r` 原地刷新。每一行只保留最后一个 `\r` 后面的内容（先把 `\r\n` 换成 `\n`）。
6. 普通的消息是插话，当前这一步完成后马上交给模型；`+` 开头的是排队，等 agent 本来要停下时才处理。运行结束后再检查一次队列，剩下的消息接着发送。
7. Esc：忙的时候打断。Ctrl+C：清空输入框，半秒内再按一次退出。Ctrl+D：输入框为空时退出。按一次就退出太容易误操作。
8. `beforeToolCall` 等待一个 Promise；界面把输入框换成对话框，用户按键时 resolve 这个 Promise，再换回输入框。运行被打断时，`signal` 的 abort 事件让它当作拒绝。
9. 事情都是异步发生的，需要的时间不确定。固定的等待时间在机器忙时可能不够，测试时好时坏；轮询在条件成立时立即继续。

</details>

## 14. 对照 pi 源码

- **[interactive-mode.ts](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts)**：读 `handleEvent` 方法（搜索 `case "message_start"`），和我们的结构几乎一样：`streamingComponent`、`pendingTools`（按 id 记录工具组件）、`updatePendingMessagesDisplay`（排队区）。界面的布局在构造函数里：`headerContainer`、`chatContainer`、`pendingMessagesContainer`、`statusContainer`、`editorContainer`、`footer`。`setupKeyHandlers` 里是 Esc（运行时把排队的消息放回输入框并打断）、Ctrl+C（`handleCtrlC`：清空，500 毫秒内再按一次退出）、Ctrl+D。斜杠命令有几十个（`/model`、`/resume`、`/tree`、`/fork`……），在提交处理里逐个判断。
- **[components/](../../packages/coding-agent/src/modes/interactive/components/)**：`assistant-message.ts`（思考过程可以点击折叠）、`tool-execution.ts`（工具可以自定义显示方式：`renderCall`、`renderResult`，见 `src/core/tools/renderers/`）、`footer.ts`（还显示 git 分支、缓存命中率、扩展的状态）、`user-message.ts`（用背景色把用户的消息框起来）。各种选择菜单（`model-selector.ts`、`session-selector.ts`……）显示时，用 `showSelector` 替换掉输入框，和我们的确认对话框一样。
- **[src/core/tools/renderers/bash.ts](../../packages/coding-agent/src/core/tools/renderers/bash.ts)**：bash 的预览同样显示最后几行（`BASH_PREVIEW_LINES = 5`），按 Ctrl+O 展开。
- **确认危险的命令**：pi 本身不拦截任何命令（见 [docs/security.md](../../packages/coding-agent/docs/security.md)），这个功能由示例扩展 [permission-gate.ts](../../packages/coding-agent/examples/extensions/permission-gate.ts) 实现，它在 `tool_call` 事件里用 `ctx.ui.select` 弹出一个选择菜单。
- **测试**：pi 的交互模式测试是 [test/](../../packages/coding-agent/test/) 目录下的 `interactive-mode-*.test.ts`，同样用 tui 包里的 `VirtualTerminal` 做假终端；`AgentSession` 的测试在 [test/suite/](../../packages/coding-agent/test/suite/)，用 `harness.ts` 加上假的服务商（faux）。

## 15. 闭卷挑战

不看资料，写出：

1. `handleEvent`：至少处理 `message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_end`、`agent_end`；
2. `ToolExecutionView` 的 bash 预览（最后 5 行）和 `sanitizeOutput`；
3. 全局快捷键：Esc 打断、Ctrl+C 按两次退出。

让 `test/interactive.test.ts` 的大部分测试通过。

---

上一步：[里程碑 18：输入框与 Markdown](../18-editor/README.md) · 下一步：[里程碑 20：打磨](../20-polish/README.md)
