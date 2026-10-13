# 里程碑 02：异步编程与流

> 目标：理解"等待"在程序里是怎么回事，学会 `Promise`、`async/await`、`fetch`、异步生成器和取消操作。
>
> 完成后你将拥有：`playground/typewriter.ts`——一个模拟大模型"一个字一个字吐出来"的打字机程序，并且按 Ctrl+C 能优雅地中途停止。它的结构和真正的流式输出一模一样。

## 你将学到

- 为什么需要异步，事件循环的直观理解
- `Promise` 和 `async/await`
- 串行与并行：`Promise.all`
- 用 `fetch` 发 HTTP 请求，HTTP 的基本概念
- 用 `fs/promises` 读写文件
- **异步生成器**（`async function*` 和 `for await`）：流式输出的核心
- **取消**：`AbortController` 和 `AbortSignal`
- 订阅模式：用回调接收事件

## 为什么这一章很重要

一个 coding agent 的大部分时间都在**等**：

- 等大模型回复（几秒到几十秒）
- 等文件读写
- 等命令执行完（跑测试可能要一分钟）
- 等用户按键

而且它必须**一边等一边做别的事**：模型还在吐字时，界面要实时显示；命令在跑时，用户要能按 Esc 取消。这一章就是在学"怎么写会等待的程序"。

本章的例子都在 [code/playground/](code/playground/) 里。

---

## 1. 同步和异步

**问题**：发一个网络请求要 3 秒。如果程序在这 3 秒里什么都不做、完全卡住（这叫**同步阻塞**），那么界面会冻结、按键没反应、也没法取消。

**解决**：**异步**。发出请求后不傻等，而是说"好了叫我"，然后去处理别的事情；请求完成时，再回来处理结果。

打个比方：餐厅里一个服务员（JavaScript 只有一个"服务员"，叫单线程），给 1 号桌点完菜，把单子交给厨房，不会站在厨房门口等，而是去给 2 号桌点菜。菜做好了，厨房喊一声，服务员再去端菜。

### 事件循环

Node.js 的运行方式可以简化成这样：

```
执行完当前的代码
循环 {
    看看有没有"已经完成、等着被处理"的事情（定时器到了、网络数据来了、文件读完了……）
    有就执行它对应的回调函数
}
```

这叫**事件循环（event loop）**。理解它，你就能解释下面这个程序的输出顺序。

[code/playground/event-loop.ts](code/playground/event-loop.ts)：

```ts
console.log("1. 开始");

setTimeout(() => {
	console.log("4. 定时器到了（0 毫秒）");
}, 0);

Promise.resolve().then(() => {
	console.log("3. Promise 回调");
});

console.log("2. 结束");
```

先猜一猜，再运行 `node playground/event-loop.ts`：

```
1. 开始
2. 结束
3. Promise 回调
4. 定时器到了（0 毫秒）
```

- `setTimeout(回调, 0)` 并不是"立刻执行"，而是"0 毫秒后把回调放进待办队列"。它必须等当前代码全部执行完。
- Promise 的回调比定时器更优先（它们在一个叫"微任务"的更高优先级队列里）。

你不需要记住所有细节，只要记住最关键的一点：**回调永远不会打断正在执行的代码，它总是在当前代码执行完之后才运行。**

## 2. Promise：一个"将来的值"

`Promise` 代表一个**现在还没有、但将来会有**的值。它有三种状态：

- **pending**（等待中）
- **fulfilled**（已兑现）：拿到了结果
- **rejected**（已拒绝）：出错了

最常用的例子：把 `setTimeout` 包装成一个 Promise：

```ts
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`new Promise((resolve, reject) => { ... })` 创建一个 Promise。你在里面启动异步操作，操作成功时调用 `resolve(结果)`，失败时调用 `reject(错误)`。这里我们 ms 毫秒后调用 `resolve`，没有结果，所以类型是 `Promise<void>`。

## 3. async / await

有了 Promise，怎么"等它完成再继续"？用 `await`：

```ts
async function fakeTool(name: string, ms: number): Promise<string> {
	await sleep(ms);
	return `${name} 完成（用时 ${ms}ms）`;
}

async function main(): Promise<void> {
	const result = await fakeTool("read", 300);
	console.log(result);
}
```

- `await 一个Promise`：暂停当前函数，等 Promise 兑现，拿到结果后继续往下执行。**暂停期间，事件循环可以去处理别的事情**，程序没有卡住。
- 用了 `await` 的函数必须标记为 `async`。`async` 函数总是返回一个 Promise：`return "x"` 实际上返回的是 `Promise<string>`。
- 在模块的最外层（不在任何函数里），可以直接写 `await`，叫**顶层 await**。我们的 `typewriter.ts` 最后一行 `await main();` 就是。

### 错误处理

`await` 一个被拒绝的 Promise，会**抛出异常**，所以可以用熟悉的 `try/catch`：

```ts
try {
	await flakyRequest();
} catch (error) {
	console.log("捕获到错误：", error instanceof Error ? error.message : String(error));
}
```

### 最常见的错误：忘记 await

```ts
const forgot = fakeTool("忘了 await", 10);
console.log(forgot);   // Promise { <pending> }
```

忘记写 `await`，你拿到的是 Promise 对象本身，而不是结果。另一个后果是：如果这个 Promise 后来失败了，没人接住它的错误，Node 会把它当作"未处理的拒绝"（unhandled rejection），直接打印错误并让程序退出。遇到奇怪的 `Promise { <pending> }` 或 `[object Promise]`，第一反应就是检查是不是漏了 `await`。

## 4. 串行与并行

[code/playground/async-basics.ts](code/playground/async-basics.ts) 里有这样的对比：

```ts
// 串行：一个做完再做下一个
await fakeTool("A", 300);
await fakeTool("B", 300);
await fakeTool("C", 300);          // 总共约 900ms

// 并行：同时开始，一起等
const results = await Promise.all([
	fakeTool("A", 300),
	fakeTool("B", 300),
	fakeTool("C", 300),
]);                                 // 总共约 300ms
```

`Promise.all([p1, p2, p3])` 等所有 Promise 都兑现，返回结果数组，**顺序和传入的顺序一致**（不是完成的顺序）。只要有一个失败，整体就失败。

> 这和 agent 有什么关系？模型有时会一次要求调用多个工具，比如"同时读取 a.ts、b.ts、c.ts"。串行执行要 3 倍时间，并行执行则快得多。pi 默认就是并行执行工具的（里程碑 10 会实现）。

运行 `node playground/async-basics.ts` 亲眼看看时间差。

## 5. fetch：发 HTTP 请求

和大模型通信靠的是 **HTTP**。先了解几个概念：

- **请求（request）** 包含：
  - **方法**：`GET`（获取）、`POST`（提交数据）等。调用大模型用 `POST`。
  - **URL**：地址，例如 `https://api.deepseek.com/chat/completions`。
  - **请求头（headers）**：附加信息，例如 `Content-Type: application/json`（"我发的是 JSON"）、`Authorization: Bearer sk-xxx`（"这是我的 API key"）。
  - **请求体（body）**：要提交的数据，通常是 JSON 文本。
- **响应（response）** 包含：
  - **状态码**：`200` 成功；`400` 请求有问题；`401` 没有权限（API key 错了）；`404` 地址不存在；`429` 请求太频繁；`500` 服务器出错。
  - **响应头**和**响应体**。

Node.js 内置了 `fetch` 函数。先启动课程提供的[假模型服务器](../tools/fake-llm/README.md)（另开一个终端，保持运行）：

```bash
node ~/pi/learn/tools/fake-llm/server.ts
```

（把 `~/pi` 换成你存放本课程的位置。）

然后看 [code/playground/fetch-demo.ts](code/playground/fetch-demo.ts)：

```ts
const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:4000/v1";

const response = await fetch(`${baseUrl}/models`);
console.log("状态码：", response.status, response.ok ? "（成功）" : "（失败）");
console.log("内容类型：", response.headers.get("content-type"));
const body: unknown = await response.json();
console.log("响应体：", JSON.stringify(body, null, 2));
```

- `fetch(url)` 返回一个 Promise，兑现为 `Response` 对象。
- `response.json()` **也是异步的**：响应头先到，响应体可能还在路上，要等它全部到达再解析。同理还有 `response.text()`。
- `process.env.LLM_BASE_URL`：读取**环境变量**。环境变量是启动程序时由外界传进来的配置，下一章会大量使用。

有两个特别容易踩的坑，fetch-demo.ts 里都演示了：

```ts
// 坑一：fetch 不会因为 404、500 这类错误状态码抛异常！必须自己检查 response.ok
const bad = await fetch(`${baseUrl}/not-exist`);
console.log(bad.status, bad.ok);   // 404 false

// 坑二：只有"根本连不上服务器"时，fetch 才会抛异常
try {
	await fetch("http://localhost:1/never");
} catch (error) {
	console.log(error.message);      // fetch failed
}
```

运行 `node playground/fetch-demo.ts`。同时看看假模型服务器那个终端，它会打印收到的请求。

## 6. 读写文件

coding agent 的核心能力之一是读写文件。Node 提供了 `node:fs/promises` 模块，所有操作都是异步的。[code/playground/files.ts](code/playground/files.ts)：

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = join(process.cwd(), "tmp-files-demo");
const file = join(dir, "note.txt");

await mkdir(dir, { recursive: true });
await writeFile(file, "第一行\n第二行\n第三行\n", "utf-8");
const content = await readFile(file, "utf-8");
```

- `node:` 前缀表示这是 Node 内置模块。
- `join(...)` 把路径片段拼起来，会自动处理分隔符（Windows 用 `\`，其他系统用 `/`）。**不要自己用 `+` 拼路径。**
- `"utf-8"` 是文字编码。不写的话，`readFile` 返回的是原始字节（`Buffer`），而不是字符串。
- 文件不存在时，`readFile` 会抛出一个 `code` 为 `"ENOENT"` 的错误。

里程碑 11 实现 `read`、`write`、`edit` 工具时，用的就是这些函数。

## 7. 异步生成器：流式输出的核心

这是本章最重要的一节。

### 7.1 问题：结果是一点一点来的

用过 ChatGPT 的人都知道，回答是**一个字一个字**蹦出来的，而不是等很久之后一次性出现。这叫**流式输出（streaming）**。大模型生成一段长回答可能需要 30 秒，如果非要等全部生成完再显示，用户会以为程序卡死了。

所以，程序需要一种方式来表示"**一连串陆续到达的值**"。一个 Promise 只能表示"将来的**一个**值"，不够用。

### 7.2 先看同步的生成器

普通函数用 `return` 返回**一个**值就结束了。**生成器函数**（`function*`）可以用 `yield` **多次**产出值：

```ts
function* countToThree() {
	yield 1;
	yield 2;
	yield 3;
}

for (const n of countToThree()) {
	console.log(n);   // 1, 2, 3
}
```

关键在于：生成器是**惰性的**。调用 `countToThree()` 时，函数体一行都没执行；`for...of` 每要一个值，它才执行到下一个 `yield`，交出值，然后**暂停**，等下一次索取。

### 7.3 异步生成器

把 `async` 和 `function*` 结合起来，就得到**异步生成器**：在两次 `yield` 之间可以 `await`。用 `for await...of` 来消费：

```ts
async function* fakeStream(text: string): AsyncGenerator<string> {
	for (const char of Array.from(text)) {
		yield char;
		await sleep(50);
	}
}

for await (const chunk of fakeStream("你好，世界")) {
	process.stdout.write(chunk);
}
```

`for await` 每拿到一块，就立刻打印。整个过程中事件循环一直在运转，程序没有卡住。

这正是我们处理大模型流式响应的方式：**网络数据一块一块地到达，我们用异步生成器把它们变成一个个"事件"，界面用 `for await` 一个个消费并显示。**

### 7.4 生产者和消费者

注意 `fakeStream` 只负责**产生**数据，完全不关心数据会被打印到终端、显示在网页上、还是保存进文件。`for await` 那边负责**消费**。这种分离非常重要：

- 在 mini-pi 里，"解析模型响应"的代码是生产者，"终端界面"是消费者。
- 同一个生产者可以接不同的消费者：交互界面一个字一个字显示；`-p` 模式只在最后打印完整结果；测试代码把所有事件收集起来检查。

## 8. 取消：AbortController

**问题**：模型正在长篇大论，但你发现自己问错了，想让它停下来。或者 agent 执行了一个死循环的命令，你想终止它。程序要怎么"中途取消"一个正在进行的异步操作？

**解决**：JavaScript 的标准做法是 `AbortController`：

```ts
const controller = new AbortController();
const signal = controller.signal;     // 把 signal 交给要被取消的操作

signal.aborted;                       // false
controller.abort();                   // 发出取消信号
signal.aborted;                       // true
```

- `controller` 在**你**手里，用来发出取消命令。
- `signal` 交给**被取消的一方**，它通过检查 `signal.aborted` 或监听 `abort` 事件来得知"我被取消了"。

很多内置函数直接支持 signal，比如 fetch：

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);    // 1 秒后取消
await fetch(url, { signal: controller.signal }); // 1 秒还没完成，就会抛出 AbortError
```

还有一个方便的写法：`AbortSignal.timeout(5000)` 返回一个 5 秒后自动触发的 signal，适合做超时。

### 8.1 让自己的函数支持取消

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
```

两种情况都要处理：调用时**已经**取消了（`signal.aborted` 为 true），以及**等待中**被取消（监听 `abort` 事件）。`{ once: true }` 表示这个监听函数只触发一次就自动移除。

### 8.2 接住 Ctrl+C

在终端里按 Ctrl+C，系统会给程序发送一个叫 `SIGINT` 的**信号**。默认情况下程序会立即退出。我们可以接住它，改成"优雅地停下"：

```ts
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
```

## 9. 综合项目：打字机

把第 7、8 节结合起来，就得到 [code/playground/typewriter.ts](code/playground/typewriter.ts)。请先自己尝试写，再对照参考。它由三部分组成：

1. 可取消的 `sleep(ms, signal)`（第 8.1 节）。
2. 生产者 `fakeStream(text, signal)`：把文字切成 1~3 个字的小块，每隔 30~100 毫秒 `yield` 一块；如果 `signal.aborted`，就 `return` 结束。
3. 消费者 `main()`：创建 `AbortController`，接住 Ctrl+C，`for await` 循环打印每一块，最后打印统计。

生产者的核心：

```ts
async function* fakeStream(text: string, signal?: AbortSignal): AsyncGenerator<string> {
	const chars = Array.from(text);
	let i = 0;
	while (i < chars.length) {
		if (signal?.aborted) return;
		const size = 1 + Math.floor(Math.random() * 3);
		yield chars.slice(i, i + size).join("");
		i += size;
		await sleep(30 + Math.random() * 70, signal);
	}
}
```

为什么用 `Array.from(text)` 而不是直接 `text[i]`？JavaScript 字符串的下标是按"UTF-16 编码单元"算的，大部分汉字占 1 个单元，但 emoji 等字符占 2 个。`text[i]` 可能把一个 emoji 切成两半，变成乱码。`Array.from(text)` 按真正的字符拆分。

消费者的核心：

```ts
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

for await (const chunk of fakeStream(story, controller.signal)) {
	process.stdout.write(chunk);   // write 不换行，console.log 会换行
}
process.stdout.write("\n");
```

运行 `node playground/typewriter.ts`，看文字逐渐出现。再运行一次，在中途按 Ctrl+C：

```
从前有一个程序员，他想写一个 coding agent
（被你中断了：共 27 个字，用时 1056ms）
```

程序没有崩溃，而是停下来并告诉你发生了什么。**这个程序的结构，就是后面 mini-pi 流式输出的结构**：生产者解析网络数据并产出事件，消费者显示事件，AbortController 负责取消。

## 10. 订阅模式

还有一种接收"一连串事件"的方式：**订阅**。你把一个回调函数交给事件的来源，说"有事件就调用它"：

```ts
const unsubscribe = agent.subscribe((event) => {
	if (event.type === "text") process.stdout.write(event.delta);
});
// ……不想再收到时：
unsubscribe();
```

和 `for await` 的区别：

| | `for await` 拉取 | 订阅推送 |
| --- | --- | --- |
| 谁掌握节奏 | 消费者：要一个拿一个 | 生产者：有事件就推过来 |
| 消费者数量 | 通常一个 | 可以多个（界面、日志、会话保存……同时订阅） |
| 适合 | 处理单次请求的响应流 | 长期存在的对象（比如 Agent）发出的事件 |

mini-pi 两种都会用：**模型响应**用异步迭代（里程碑 05、06），**Agent 事件**用订阅（里程碑 10）。练习 5 会让你自己实现一个订阅器。

## 11. 运行与验证

- [ ] `node playground/event-loop.ts`，能解释输出顺序
- [ ] `node playground/async-basics.ts`，看到串行约 900ms、并行约 300ms
- [ ] 启动假模型服务器后，`node playground/fetch-demo.ts` 能打印模型列表
- [ ] `node playground/files.ts` 能写入并读回文件
- [ ] `node playground/typewriter.ts` 逐字输出；中途按 Ctrl+C 能优雅停止
- [ ] `npx tsc` 没有错误

## 12. 练习

把练习文件复制到 `my-pi/playground/`，完成 TODO，运行直到看到"全部通过"。参考答案在 [solutions/](solutions/)。

| 练习 | 内容 | 以后在哪里用到 |
| --- | --- | --- |
| [ex1-sleep-retry.ts](exercises/ex1-sleep-retry.ts) | `sleep`、失败重试 `retry`、超时 `withTimeout` | 里程碑 20：请求失败自动重试 |
| [ex2-parallel.ts](exercises/ex2-parallel.ts) | 串行、并行、"一个失败不影响其他"的并行 | 里程碑 10：并行执行工具 |
| [ex3-generators.ts](exercises/ex3-generators.ts) | 异步生成器；把任意切分的文字片段重新组装成完整的行 | 里程碑 05：解析流式响应 |
| [ex4-abort.ts](exercises/ex4-abort.ts) | 可取消的 sleep；中途取消一串步骤 | 里程碑 10、12：取消 agent、终止命令 |
| [ex5-emitter.ts](exercises/ex5-emitter.ts) | 订阅/取消订阅 | 里程碑 10：Agent 事件 |

练习 3 的 `lines` 函数值得特别花时间：网络数据到达时，可能在任意位置被切开，比如一行字被切成两半分两次到达。把碎片重新拼成完整的行，是里程碑 05 的关键一步。

## 13. 自测问题

1. 下面的代码打印什么？为什么？
   ```ts
   setTimeout(() => console.log("A"), 0);
   console.log("B");
   ```
2. `await` 的时候，整个程序会卡住吗？
3. `fetch` 请求返回 500 时，会抛异常吗？你应该怎么判断请求是否成功？
4. 为什么 `Promise.all` 并行执行三个 300ms 的任务只需要约 300ms？
5. 生成器"惰性"是什么意思？
6. 想让一个异步操作可以被取消，需要做哪两件事？
7. 订阅模式和 `for await` 各适合什么场景？

<details>
<summary>参考答案</summary>

1. 先打印 B，再打印 A。定时器回调要等当前代码执行完才会运行，即使延迟是 0。
2. 不会。只有当前这个 async 函数暂停了，事件循环仍在处理其他事情（定时器、网络、按键）。
3. 不会。要检查 `response.ok`（状态码在 200~299 之间时为 true）或 `response.status`。
4. 三个任务同时开始，大家一起等，等待时间重叠了。
5. 调用生成器函数时不执行函数体；每次有人索取下一个值时，它才执行到下一个 `yield`。
6. 接收一个 `AbortSignal` 参数；在开始时检查 `signal.aborted`，并在等待期间监听 `abort` 事件，收到后停止工作并清理（比如清除定时器）。
7. `for await` 适合"一次请求对应一个响应流、只有一个消费者"的场景；订阅适合长期存在、可能有多个消费者的事件来源。

</details>

## 14. 对照 pi 源码

- **事件流**：[packages/ai/src/utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts) 里的 `EventStream` 类实现了 `[Symbol.asyncIterator]`，所以可以被 `for await` 消费。它内部用一个队列和一个"等待者"列表，把"生产者推送"转换成了"消费者拉取"。里程碑 06 我们会写一个简化版。
- **取消**：pi 的每一个工具都接收 `signal?: AbortSignal`。打开 [packages/coding-agent/src/core/tools/write.ts](../../packages/coding-agent/src/core/tools/write.ts)，你会看到：
  ```ts
  const throwIfAborted = (): void => {
  	if (signal?.aborted) throw new Error("Operation aborted");
  };
  throwIfAborted();
  await ops.mkdir(dir);
  throwIfAborted();
  await ops.writeFile(absolutePath, content);
  ```
  每做完一步异步操作就检查一次有没有被取消——和我们练习 4 的思路一样。
- **订阅**：[packages/agent/src/agent.ts](../../packages/agent/src/agent.ts) 里的 `subscribe` 方法：
  ```ts
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
  	this.listeners.add(listener);
  	return () => this.listeners.delete(listener);
  }
  ```
  和练习 5 几乎一样：用一个 `Set` 保存监听函数，返回一个取消订阅的闭包。
- **并行执行工具**：[packages/agent/src/agent-loop.ts](../../packages/agent/src/agent-loop.ts) 里的 `executeToolCallsParallel` 用 `Promise.all` 等待所有工具完成，而结果"按模型请求的顺序"排列——正是练习 2 考察的点。

## 15. 闭卷挑战

不看任何资料，从零写出 `typewriter.ts`：异步生成器产出文字片段、可取消的 sleep、Ctrl+C 优雅停止、最后打印统计。20 分钟内完成，就可以进入下一阶段了。

恭喜你完成了"准备"阶段！从下一个里程碑开始，我们要和真正的大模型对话了。

---

上一步：[里程碑 01：TypeScript 最小必要知识](../01-typescript/README.md) · 下一步：[里程碑 03：第一次调用大模型](../03-first-call/README.md)
