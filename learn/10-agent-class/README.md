# 里程碑 10：Agent 类

> 目标：把 `runAgentLoop` 包装成一个有状态的 `Agent` 类，并加上真实的 agent 必不可少的三个能力：用户在 agent 工作时**插话**（steering）、**排队**下一个任务（follow-up），以及**同时执行**多个工具。
>
> 完成后你将拥有：`src/agent/agent.ts`、升级后的 `src/agent/loop.ts`，以及支持插话和排队的 `playground/agent-demo.ts`。

```
$ node playground/agent-demo.ts
你> 读取 package.json 然后 计算 23*47
我来（已插话：当前这一步完成后发给模型）           ← agent 工作时，你输入了"现在几点"
读取 package.json。
> read {"path":"package.json"}
< read
  ……
[发给模型] 现在几点                                ← read 执行完、下一次请求模型之前，插话被发出
我来查一下当前时间。
> get_current_time {}
< get_current_time
  2026/10/12 22:32:56
……
（请求模型 3 次，调用工具 2 次，共 454 tokens，用时 2.1 秒）
```

## 你将学到

- 为什么需要一个"有状态"的类：保存状态、订阅事件、随时取消
- 从事件推导出状态：`state.messages` 是怎么来的
- 插话和排队的区别，以及怎样用两层循环实现它们
- 同时执行多个工具，并且让结果保持原来的顺序

---

## 1. 问题：一个函数不够用

上一章的 `agent-demo.ts` 里，调用者要自己操心很多事：

- 保存历史：每次运行完都要 `history.push(...newMessages)`；
- 管理取消：每次运行都新建一个 `AbortController`，按 Ctrl+C 时要找到它；
- 记住"是否正在运行"：用一个 `current` 变量；
- 运行期间用户输入的内容：被 `for await` 卡住了，只能等运行结束才处理。

到了里程碑 19 的全屏界面，关心 agent 状态的地方更多：输入框（运行中按回车是插话）、状态栏（"正在执行 bash……"）、消息列表、会话文件（里程碑 14）……把这些状态集中放在一个对象里，让需要的地方订阅它的事件，是最自然的做法。

另外，真实使用时有两个很常见的需求：

- 看到 agent 走错了方向，想**插话**纠正它："别改那个文件，改另一个"。但不想打断它正在执行的命令。
- agent 正在忙，想先把**下一个任务**告诉它："做完之后再更新一下 README"。

还有一个效率问题：模型经常一次调用好几个工具（比如同时读 3 个文件），一个一个执行太慢了。

## 2. Agent 类

### 2.1 用法

```ts
const agent = new Agent({ model, systemPrompt, tools });
agent.subscribe((event) => { /* 显示到屏幕上 */ });

await agent.prompt("读取 package.json");   // 运行，直到完成
await agent.prompt("里面有哪些依赖？");     // 历史自动保存，模型记得上一个问题
console.log(agent.state.messages);         // 完整的对话
```

调用者不用再管历史、`AbortController` 和"是否正在运行"了。

### 2.2 状态

[code/src/agent/agent.ts](code/src/agent/agent.ts)：

```ts
export interface AgentState {
	systemPrompt: string;
	model: Model;
	tools: AgentTool[];
	messages: Message[];             // 完整的对话历史
	isStreaming: boolean;            // 是否正在运行
	streamingMessage?: Message;      // 正在流式接收的消息（还没完成）
	pendingToolCalls: Set<string>;   // 正在执行的工具调用的 id
	errorMessage?: string;           // 最近一次出错（或被取消）时的错误信息
}
```

前四个是"配置和数据"，可以在两次运行之间修改，比如 `agent.state.model = otherModel` 换一个模型（里程碑 20）。后四个是"运行时的状态"，给界面读的：`streamingMessage` 用来显示模型正在输入的内容，`pendingToolCalls` 用来显示"正在执行……"。

### 2.3 状态是从事件推导出来的

`Agent` 把自己的 `handleEvent` 方法作为 `emit` 传给 `runAgentLoop`。每收到一个事件，先更新状态，再通知所有订阅者：

```ts
private async handleEvent(event: AgentEvent): Promise<void> {
	switch (event.type) {
		case "message_start":
		case "message_update":
			this.state.streamingMessage = event.message;
			break;
		case "message_end":
			// 对话历史就是这样一条条记录下来的：每条消息完成时加入历史
			this.state.streamingMessage = undefined;
			this.state.messages.push(event.message);
			break;
		case "tool_execution_start":
			this.state.pendingToolCalls.add(event.toolCallId);
			break;
		case "tool_execution_end":
			this.state.pendingToolCalls.delete(event.toolCallId);
			break;
		case "turn_end":
			if (event.message.errorMessage) this.state.errorMessage = event.message.errorMessage;
			break;
	}
	for (const listener of this.listeners) {
		await listener(event);
	}
}
```

注意：**往 `state.messages` 里加消息的地方只有一处**，就是 `message_end`。`Agent` 甚至不使用 `runAgentLoop` 的返回值。上一章我们保证了"每条加入对话的消息都会发出 `message_start` / `message_end`"，这里就用上了。

这种写法叫做**从事件推导状态**：状态 = 初始状态 + 依次处理每个事件。好处是界面看到的事件和 agent 记录的状态一定一致，不会出现"界面上显示了，历史里却没有"的情况。里程碑 14 保存会话时也会这样做：每收到一个 `message_end`，就往文件里追加一行。

先更新状态、再通知订阅者，这个顺序也很重要：订阅者收到 `message_end` 时，`agent.state.messages` 里已经有这条消息了。

### 2.4 prompt：同一时间只能有一个运行

```ts
async prompt(input: string | Message | Message[]): Promise<void> {
	if (this.activeRun) {
		throw new Error("agent 正在运行。请用 steer() 或 followUp() 排队，或者等它完成。");
	}
	const prompts = typeof input === "string" ? [userMessage(input)] : Array.isArray(input) ? input : [input];

	const abortController = new AbortController();
	let finish = () => {};
	const promise = new Promise<void>((resolve) => {
		finish = resolve;
	});
	this.activeRun = { promise, abortController };
	this.state.isStreaming = true;
	this.state.errorMessage = undefined;

	try {
		await runAgentLoop(
			prompts,
			{ systemPrompt: this.state.systemPrompt, messages: [...this.state.messages], tools: [...this.state.tools] },
			this.createLoopConfig(),
			(event) => this.handleEvent(event),
			abortController.signal,
		);
	} finally {
		// 不管成功还是出错，都要回到空闲状态，否则 agent 就再也不能用了
		this.state.isStreaming = false;
		this.state.streamingMessage = undefined;
		this.state.pendingToolCalls = new Set();
		this.activeRun = undefined;
		finish();
	}
}
```

三个要点：

**为什么运行中不能再调用 `prompt`？** 两个循环同时往同一份历史里加消息，顺序就乱了：A 的工具调用后面可能跟着 B 的用户消息，配对规则被破坏。运行中想说话，请用下一节的 `steer()` 或 `followUp()`。

**为什么用 `try/finally`？** `runAgentLoop` 本身不会因为模型或工具出错而抛出异常（它把错误变成了消息），但订阅者的代码可能有 bug，抛出异常。`finally` 保证无论如何都回到空闲状态，异常照常抛给调用者。（`agent.test.ts` 的最后一个测试检查了这一点。）

**`finish` 是什么？** 这是一个常用技巧：先创建一个 Promise，把它的 `resolve` 函数存起来，以后再调用。里程碑 06 的 `EventStream` 里用过同样的写法。这里存起来的 Promise 用于 `waitForIdle()`：

```ts
abort(): void {
	this.activeRun?.abortController.abort();
}

waitForIdle(): Promise<void> {
	return this.activeRun?.promise ?? Promise.resolve();
}
```

`prompt()` 的调用者可以直接 `await agent.prompt(...)`；其他地方的代码（比如"退出程序之前，等当前的任务做完"）用 `waitForIdle()`。

### 2.5 API key 每次运行时获取

```ts
private createLoopConfig(): AgentLoopConfig {
	return {
		model: this.state.model,
		apiKey: this.getApiKey(this.state.model.provider),
		// ……
	};
}
```

`getApiKey` 默认是 ai 层的 `getApiKey`（从环境变量读取）。每次运行时按**当前模型**的服务商获取，这样换了模型，key 也会跟着换。

## 3. 插话与排队

### 3.1 两种消息的区别

```
时间 →
agent：[请求模型]→[执行 bash: npm test（30 秒）]→[请求模型]→[执行 edit]→[请求模型：最终回答] 本来要停了
                      ↑                                                                  ↓
                      你插话："别改测试文件"                                              处理排队的消息
                      → bash 执行完之后、下一次请求模型之前，加入对话                       "完成后更新 README"
                      你排队："完成后更新 README"
                      → 等 agent 本来要停下时，才加入对话
```

| | 插话 `steer()` | 排队 `followUp()` |
| --- | --- | --- |
| 什么时候发给模型 | 当前这一轮的工具执行完之后 | agent 本来要停下的时候 |
| 典型用途 | 纠正方向、补充信息 | 下一个任务 |
| 会打断正在执行的工具吗 | 不会 | 不会 |
| pi 里的按键 | 运行中按 Enter | 运行中按 Alt+Enter |

两者都**不会打断**正在执行的工具。想立刻停下，用 `abort()`（Ctrl+C / Esc）。

实现很简单，两个数组：

```ts
private readonly steeringQueue: Message[] = [];
private readonly followUpQueue: Message[] = [];

steer(input: string | Message): void {
	this.steeringQueue.push(typeof input === "string" ? userMessage(input) : input);
}

followUp(input: string | Message): void {
	this.followUpQueue.push(typeof input === "string" ? userMessage(input) : input);
}
```

循环通过配置里的两个函数来取消息：

```ts
getSteeringMessages: () => this.steeringQueue.splice(0, 1),
getFollowUpMessages: () => this.followUpQueue.splice(0, 1),
```

`splice(0, 1)` 从数组开头取出（并删除）一个元素，返回一个数组（队列空时返回空数组）。每次只取一条：如果你连续排了三个任务，agent 会做完第一个再看第二个，而不是同时收到三个。

为什么 `Agent` 不直接把数组交给循环，而是给两个函数？因为循环属于更底层的 agent loop，它不应该知道 `Agent` 类的存在。"给我下一条消息"这个函数接口，让循环可以配合任何来源工作。测试里就是直接传一个函数，不需要创建 `Agent`。

### 3.2 循环的改造：两层循环

[code/src/agent/loop.ts](code/src/agent/loop.ts) 的主体变成了这样：

```ts
// 用户可能在 agent 启动前就插话了
let pending: Message[] = (await config.getSteeringMessages?.()) ?? [];
let firstTurn = true;

// 外层循环：agent 本来要停下时，看看有没有排队的消息（follow-up）
outer: while (true) {
	let hasMoreToolCalls = true;

	// 内层循环：还有工具调用、或者有插话，就继续
	while (hasMoreToolCalls || pending.length > 0) {
		if (!firstTurn) await emit({ type: "turn_start" });
		firstTurn = false;

		// ① 把插话或排队的消息加入对话
		for (const message of pending) await appendWithEvents(message);
		pending = [];

		// ② 调用模型
		const assistant = await streamAssistantResponse(messages, context, config, emit, signal);
		append(assistant);

		// ③ 出错或被取消：整个运行结束
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			await emit({ type: "turn_end", message: assistant, toolResults: [] });
			break outer;
		}

		// ④ 执行工具
		const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
		const toolResults =
			config.toolExecution === "sequential"
				? await executeSequential(toolCalls, assistant, context.tools, emit, signal)
				: await executeParallel(toolCalls, assistant, context.tools, emit, signal);
		for (const result of toolResults) append(result);
		await emit({ type: "turn_end", message: assistant, toolResults });

		// ⑤ 工具执行期间被取消了：不再调用模型
		if (signal?.aborted) break outer;

		// ⑥ 没有工具调用时，模型已经给出了最终回答；但用户可能刚刚插了话
		hasMoreToolCalls = toolCalls.length > 0;
		pending = (await config.getSteeringMessages?.()) ?? [];
	}

	// ⑦ agent 本来要停下了。有排队的消息就继续，没有就真的结束
	pending = (await config.getFollowUpMessages?.()) ?? [];
	if (pending.length === 0) break;
}
```

和上一章对比，内层循环就是原来的循环，只多了两件事：开头把 `pending` 里的消息加入对话（①），结尾检查有没有新的插话（⑥）。循环继续的条件从"还有工具调用"变成了"还有工具调用，**或者**有插话"。所以即使模型已经给出了最终回答，只要用户插了话，循环也会继续，让模型回应这条插话。

外层循环在 agent 本来要停下时检查排队的消息（⑦）。有消息就把它放进 `pending`，回到内层循环。

`break outer` 是 JavaScript 的**带标签的 break**：普通的 `break` 只跳出最里面的一层循环，`break outer` 直接跳出标着 `outer:` 的那层循环。出错或被取消时，我们要一次跳出两层。

插话和排队的消息通过 `appendWithEvents` 加入对话，它会发出 `message_start` / `message_end` 事件，所以 `Agent` 会把它们记进历史，界面也能显示出来。

### 3.3 一次运行，很多轮

排队的消息被处理时，**不会**开始一次新的运行：仍然是同一个 `agent_start` … `agent_end`，只是多了几轮。所以 `await agent.prompt("任务一")` 会一直等到排队的"任务二""任务三"都处理完才返回。`agent.test.ts` 里的"followUp"测试检查了这一点。

## 4. 同时执行工具

### 4.1 为什么

模型说"我来看看这三个文件"，一次调用了三次 `read`。一个一个执行，花的时间是三者之和；同时执行，花的时间约等于最慢的那个。对于运行很慢的工具（比如几个独立的 bash 命令），差别很明显。

### 4.2 关键：结果的顺序

同时执行时，谁先完成是不确定的。但我们希望**工具结果消息的顺序和调用的顺序一致**：

- 历史可预测：同样的对话，每次保存下来都一样；
- 模型更容易理解：第 1 个结果对应第 1 个调用。

秘诀是 `Promise.all`：**它返回的结果数组和传入的 Promise 数组顺序一致，不管谁先完成。**

```ts
const results = await Promise.all([wait(300, "慢"), wait(10, "快")]);
// "快" 先完成，但 results 是 ["慢", "快"]
```

### 4.3 三个阶段

```ts
async function executeParallel(calls, assistant, tools, emit, signal): Promise<ToolResultMessage[]> {
	// ① 按顺序准备。准备失败的调用，马上发出 end 事件
	const preparations: Preparation[] = [];
	for (const call of calls) {
		await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
		const preparation = prepareToolCall(call, assistant, tools, signal);
		if (preparation.kind === "failed") await emitExecutionEnd(call, preparation.outcome, emit);
		preparations.push(preparation);
	}

	// ② 同时执行准备好的调用。Promise.all 返回的结果和传入的顺序一致，不管谁先完成
	const outcomes = await Promise.all(
		preparations.map(async (preparation) => {
			if (preparation.kind === "failed") return preparation.outcome;
			const outcome = await runPreparedCall(preparation, emit, signal);
			await emitExecutionEnd(preparation.call, outcome, emit); // 谁先完成，谁先发出 end 事件
			return outcome;
		}),
	);

	// ③ 按调用的顺序生成结果消息
	const results: ToolResultMessage[] = [];
	for (const [index, call] of calls.entries()) {
		results.push(await emitToolResult(call, outcomes[index], emit));
	}
	return results;
}
```

上一章的 `executeToolCall` 被拆成了两步：

- `prepareToolCall`：检查能不能执行（截断、取消、工具不存在、参数校验），返回 `{ kind: "ready", … }` 或 `{ kind: "failed", outcome }`。这是里程碑 01 学过的**可辨识联合**（用 `kind` 字段区分是哪一种）。
- `runPreparedCall`：真正执行工具，处理进度报告和异常，从不抛出异常。

为什么要先把所有调用都准备好，再一起执行，而不是准备好一个就马上执行一个？里程碑 12 会在"准备"阶段加入一个确认步骤："模型想执行 `rm -rf build`，允许吗？"先把所有需要确认的问题问完，再一起执行，用户体验更好，事件的顺序也更清楚。

`preparations.map(async (preparation) => …)` 会**依次启动**每个 async 函数：每个函数运行到第一个 `await` 时让出控制权，下一个函数接着启动。所以所有工具几乎同时开始执行，而不是一个等一个。

### 4.4 事件的顺序

一个慢的调用 `slow` 和一个快的调用 `fast`：

```
tool_execution_start  slow      ① 按调用顺序
tool_execution_start  fast
tool_execution_end    fast      ② 按完成顺序：界面可以尽早显示结果
tool_execution_end    slow
message_end  toolResult(slow)   ③ 按调用顺序：历史里的顺序
message_end  toolResult(fast)
```

`agent-loop.test.ts` 里的"parallel 模式的事件顺序"测试检查的就是这个顺序。

### 4.5 什么时候不能同时执行？

如果模型同时调用了两次 `edit`，修改**同一个文件**的不同地方，同时执行会出问题：两个工具都先读文件、改自己的部分、再写回去，后写的会覆盖先写的，第一处修改就丢了。

两种解决办法：

- `toolExecution: "sequential"`：全部一个一个执行，简单但慢；
- 只让"修改同一个文件"的操作排队，其他的照样同时执行。这是 pi 的做法，我们在下一章写 `edit` 工具时实现。

## 5. 运行

先启动假模型服务器。为了有时间在 agent 工作时输入，可以让它慢一点：

```bash
node learn/tools/fake-llm/server.ts --delay 150
```

然后：

```bash
node playground/agent-demo.ts
```

| 试试 | 观察 |
| --- | --- |
| 输入 `读取 package.json 然后 计算 23*47`，在它输出时马上输入 `现在几点` | 看到"已插话"。`read` 执行完之后，插话被发给模型（黄色的"发给模型"），模型转而回答时间 |
| 同样的任务，运行时输入 `+现在几点` | 看到"已排队"。agent 先完成原来的任务，再回答时间。整个过程只有一行统计：仍然是同一次运行 |
| 运行时按 Ctrl+C | 立即取消，可以接着输入新的问题 |
| 启动时加 `--tool-delay 1000`，输入 `读取 package.json 同时 计算 23*47` | 两个工具同时执行。注意 `<`（工具完成）的顺序可能和 `>`（开始）不同 |
| 再加上 `--sequential` 运行同样的输入 | 用时多了大约 1 秒 |

注意：假模型只看最后一条用户消息，所以插话之后它会"忘掉"原来的任务。真实的模型会同时考虑两条消息。用真实模型试试：

```bash
node --env-file=.env playground/agent-demo.ts --model deepseek/deepseek-chat
```

让它"读一下 src 目录下的 agent.ts 和 loop.ts，分别总结一下"，在它读文件时插话"用英文回答"。

demo 里怎样区分"空闲时输入"和"运行时输入"？看 `agent.state.isStreaming`：

```ts
rl.on("line", (rawLine) => {
	const line = rawLine.trim();
	// ……
	if (!agent.state.isStreaming) {
		currentRun = run(line);              // 空闲：开始新的运行
	} else if (line.startsWith("+")) {
		agent.followUp(line.slice(1).trim()); // 运行中，以 + 开头：排队
	} else {
		agent.steer(line);                    // 运行中：插话
	}
});
```

上一章用的是 `for await (const line of rl)`，循环体里 `await` 运行结束之前，不会读取下一行。这一章改用 `rl.on("line", …)`：每输入一行就立刻调用一次，不管 agent 是不是正在运行。

## 6. 接口约定与测试

| 文件 | 变化 |
| --- | --- |
| `src/agent/types.ts` | 新增 `ToolExecutionMode`；`AgentLoopConfig` 新增 `toolExecution`、`getSteeringMessages`、`getFollowUpMessages` |
| `src/agent/loop.ts` | 两层循环；`executeSequential` / `executeParallel`；`prepareToolCall` + `runPreparedCall` |
| `src/agent/agent.ts` | `AgentState`、`AgentOptions`、`AgentListener`、`Agent` 类：`state`、`subscribe`、`prompt`、`steer`、`followUp`、`queuedMessages`、`clearQueues`、`abort`、`waitForIdle`、`reset` |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `agent.test.ts`（17 个测试），`agent-loop.test.ts` 新增了 7 个测试。注意上一章"多个工具调用按顺序执行"的测试现在要明确指定 `toolExecution: "sequential"`，因为默认变成了并行。

`agent.test.ts` 用了一个小技巧来测试"运行期间发生的事"：让工具在执行时调用 `agent.steer()`、`agent.followUp()`。这样不需要计时器，结果完全确定：

```ts
test("steer：运行中插话，模型在下一次请求时看到", async () => {
	const faux = createFauxModel([{ toolCalls: [{ name: "work", arguments: {} }] }, { text: "收到插话" }]);
	const agent = new Agent({ model: faux.model });
	agent.state.tools = [hookTool(() => agent.steer("用 TypeScript 写"))];
	await agent.prompt("写个脚本");
	assert.deepEqual(texts(agent.state.messages), [
		"user:写个脚本",
		"assistant:",
		"toolResult:work",
		"user:用 TypeScript 写",
		"assistant:收到插话",
	]);
});
```

## 7. 常见错误

| 现象 | 原因 |
| --- | --- |
| 历史里每条消息都出现了两次 | 既在 `message_end` 里记录了消息，又把 `runAgentLoop` 的返回值追加了一遍 |
| 订阅者收到 `message_end` 时，`state.messages` 里还没有这条消息 | 先通知了订阅者，后更新状态。顺序要反过来 |
| 订阅者的代码出错一次之后，agent 永远处于"正在运行"状态 | 没有用 `finally` 恢复空闲状态 |
| 插话之后什么也没发生，直到下一次提问才出现 | 内层循环的条件只检查了工具调用，忘了 `pending.length > 0`；或者每轮结束时忘了取插话 |
| 排队的三条消息被同时发给了模型 | 用了 `splice(0)`（取出全部）而不是 `splice(0, 1)` |
| 并行执行时，工具结果的顺序每次都不一样 | 按完成顺序收集了结果。用 `Promise.all` 的返回值，它和调用顺序一致 |
| 并行执行比顺序执行还慢，或者一样快 | 在 `map` 外面又一个一个 `await` 了，比如 `for (const p of preparations) await run(p)` |

## 8. 练习

1. **按工具指定执行方式**：给 `AgentTool` 加一个可选字段 `executionMode?: ToolExecutionMode`。如果一次回复里有任何一个调用的工具要求 `"sequential"`，这一批就全部顺序执行。（pi 就是这样做的。）写一个测试。
2. **队列模式**：给 `Agent` 加一个选项 `followUpMode: "one-at-a-time" | "all"`。`"all"` 时一次取出所有排队的消息。想一想：两种模式分别适合什么场景？
3. **撤回排队的消息**：pi 运行中按 Alt+Up，会把排队的消息取回到输入框里。给 `Agent` 加一个方法 `dequeueAll(): Message[]`，取出并清空两个队列，返回取出的消息。在 demo 里加一个命令：运行中输入 `/undo`，把排队的消息打印出来。
4. **状态栏**：在 demo 里订阅事件，每当 `pendingToolCalls` 变化时，在一行里显示"正在执行：read, calculate"。（提示：工具开始和结束时都检查一次。）
5. **思考题**：用户插话时，如果模型正在输出一段很长的回答（还没调用工具），插话要等这段回答输出完才会被发送。能不能做得更快？代价是什么？

## 9. 自测问题

1. `Agent` 类比直接调用 `runAgentLoop` 多做了哪些事？
2. `state.messages` 里的消息是在哪里加进去的？为什么不使用 `runAgentLoop` 的返回值？
3. 运行中为什么不能再调用 `prompt()`？
4. 插话和排队有什么区别？它们会打断正在执行的工具吗？
5. 模型已经给出最终回答时用户插了话，会发生什么？
6. 并行执行时，怎样保证工具结果消息的顺序和调用的顺序一致？
7. 什么情况下同时执行工具会出问题？

<details>
<summary>参考答案</summary>

1. 保存历史、管理"是否正在运行"和取消、允许多个订阅者、运行中插话和排队、提供界面需要的状态（正在输入的消息、正在执行的工具、错误信息）。
2. 在处理 `message_end` 事件时。这样界面看到的事件和记录的状态一定一致，消息只在一个地方被记录。
3. 两个循环同时修改同一份历史，消息的顺序会乱，调用和结果的配对会被破坏。
4. 插话在当前这一轮的工具执行完之后发给模型，用于纠正方向；排队在 agent 本来要停下时才发给模型，用于下一个任务。两者都不会打断正在执行的工具。
5. 内层循环的条件是"还有工具调用，或者有插话"，所以循环继续：插话被加入对话，模型再回复一次。
6. 用 `Promise.all`：它返回的结果数组和传入的顺序一致，不管谁先完成。然后按这个顺序生成结果消息。
7. 多个调用修改同一个资源时，比如两次 `edit` 改同一个文件，后写入的会覆盖先写入的。

</details>

## 10. 对照 pi 源码

- **`Agent` 类**：[packages/agent/src/agent.ts](../../packages/agent/src/agent.ts)。`processEvents` 方法对应我们的 `handleEvent`：同样是先根据事件更新状态（`message_end` 时 `messages.push`），再依次 `await` 每个订阅者。`runWithLifecycle` 对应我们 `prompt` 里的 `try/finally`，`activeRun` 里同样存着 `promise` 和 `abortController`。
- **出错的处理不同**：pi 的 `handleRunFailure` 在循环抛出异常时，会造一条 `stopReason: "error"` 的助手消息，发出 `message_end`、`turn_end`、`agent_end` 事件，`prompt()` 正常返回。我们选择更简单的做法：恢复空闲状态，把异常抛给调用者。
- **队列**：`PendingMessageQueue` 类，有 `"one-at-a-time"`（默认）和 `"all"` 两种模式（练习 2）。`createLoopConfig` 里的 `getSteeringMessages` 和 `getFollowUpMessages` 就是从这两个队列里取消息。pi 还有 `continue()` 方法：不加新消息，从当前历史继续运行。里程碑 20 实现自动重试时我们会用到它。
- **两层循环**：[agent-loop.ts](../../packages/agent/src/agent-loop.ts) 的 `runLoop`。找到注释 "Outer loop: continues when queued follow-up messages arrive after agent would stop" 和 "Inner loop: process tool calls and steering messages"，结构和我们的一模一样。每轮结束后的 `pendingMessages = (await config.getSteeringMessages?.()) || []` 就是我们的第 ⑥ 步。
- **并行执行**：`executeToolCallsParallel`。pi 在准备阶段把可以执行的调用包装成函数（`finalizedCalls.push(async () => …)`），准备完之后用 `Promise.all` 一起执行，再按顺序发出工具结果消息。和我们的三个阶段一样。`executeToolCalls` 里还检查了每个工具的 `executionMode`（练习 1）。
- **界面怎么用这些状态**：pi 的界面在 agent 工作时显示一个"正在工作"的动画，排队的消息显示在输入框上方（`interactive-mode.ts` 里的 `pendingMessagesContainer`）。这些都是根据 `Agent` 的状态和事件画出来的，里程碑 19 我们会做类似的东西。

## 11. 闭卷挑战

不看资料，写出：

1. `Agent` 类的 `prompt`、`handleEvent`、`steer`、`followUp`、`abort`、`waitForIdle`；
2. 两层循环版本的 `runAgentLoop`；
3. `executeParallel` 的三个阶段。

让 `test/agent.test.ts` 和 `test/agent-loop.test.ts` 全部通过。90 分钟内完成即可进入下一阶段：给 agent 装上真正的"手"——读写文件的工具。

---

上一步：[里程碑 09：Agent Loop](../09-agent-loop/README.md) · 下一步：[里程碑 11：文件工具](../11-file-tools/README.md)
