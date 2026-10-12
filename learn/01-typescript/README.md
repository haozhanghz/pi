# 里程碑 01：TypeScript 最小必要知识

> 目标：掌握写 mini-pi 需要的全部 TypeScript 语法，并用类型把"一段对话"精确地描述出来。
>
> 完成后你将拥有：`playground/conversation.ts`——一个用类型描述"用户提问 → 模型调用工具 → 工具返回结果 → 模型回答"整个过程的程序。它就是里程碑 06 里 mini-pi 核心类型的雏形。

## 你将学到

- 变量、基本类型、数组、对象、函数
- JSON：对象和文本之间的转换（和大模型通信全靠它）
- `interface` 和 `type`：用类型描述数据
- **联合类型和类型收窄**：本章最重要的概念，mini-pi 里到处都是
- `unknown`：如何安全地处理"来路不明"的数据
- 泛型、类、模块（`import` / `export` / `import type`）
- 错误处理：`throw`、`try/catch`
- Node 直接运行 TypeScript 时**不能用**的几种语法

## 怎么学这一章

这一章内容多，但都是基础中的基础。建议：

1. 新建 `playground/ts-basics.ts`，把每一节的例子**亲手敲进去**，运行 `node playground/ts-basics.ts` 看结果，再运行 `npx tsc` 看类型检查。
2. 不需要背。后面写 mini-pi 时会反复用到，用多了自然就记住了。
3. 每学完几节，去做对应的练习（第 14 节）。练习自带检查，做对了会打印"全部通过"。
4. 想更系统地学 JavaScript，推荐同时阅读 [现代 JavaScript 教程](https://zh.javascript.info/) 的第一部分。

先说清楚一个关系：**TypeScript = JavaScript + 类型标注**。运行时执行的是 JavaScript，类型只在写代码和 `tsc` 检查时起作用。所以下面很多知识其实是 JavaScript 的知识。

本章所有例子的完整版在 [code/playground/basics.ts](code/playground/basics.ts)。

---

## 1. 值、变量和类型

```ts
const model = "deepseek-chat";   // 常量：之后不能再赋值
let tokens = 0;                  // 变量：之后可以改
tokens = tokens + 120;
const streaming: boolean = true; // 手动写出类型
```

- `const` 声明常量，`let` 声明变量。**默认用 `const`**，只有确实需要重新赋值时才用 `let`。
- 最基本的类型有三个：`string`（字符串）、`number`（数字，整数小数都是它）、`boolean`（`true` / `false`）。
- 大多数时候不用手写类型，TypeScript 会**自动推断**：`const model = "deepseek-chat"` 推断出 `model` 是 `string`。把鼠标放在 VS Code 里的变量名上就能看到推断结果。

还有两个表示"没有值"的特殊值：

- `undefined`：还没有赋值，或者"不存在"。比如读取对象里不存在的字段，得到 `undefined`。
- `null`：明确表示"空"。很多 API 会用它，比如模型回复里没有文字时，`content` 可能是 `null`。

```ts
let lastError: string | undefined;   // 要么是字符串，要么是 undefined
console.log(lastError);              // undefined
```

`string | undefined` 读作"string 或 undefined"，这是**联合类型**，第 7 节会详细讲。

## 2. 运算符与条件

```ts
const contextWindow = 128000;
const reserve = 16384;
const used = 115000;

if (used > contextWindow - reserve) {
	console.log("上下文快满了，需要压缩");
} else {
	console.log("上下文还够用");
}
```

常用运算符：

| 运算符 | 含义 | 例子 |
| --- | --- | --- |
| `===` / `!==` | 严格相等 / 不相等 | `role === "user"` |
| `>` `<` `>=` `<=` | 比较 | `tokens > 1000` |
| `&&` / `\|\|` / `!` | 并且 / 或者 / 取反 | `a > 0 && b > 0` |
| `? :` | 三元表达式 | `ok ? "成功" : "失败"` |
| `??` | 左边是 `null`/`undefined` 时用右边 | `process.env.KEY ?? "默认"` |
| `?.` | 可选链：左边是 `null`/`undefined` 时直接得到 `undefined`，不报错 | `response?.usage?.total` |

> **永远用 `===`，不要用 `==`**。`==` 会做奇怪的类型转换（比如 `0 == ""` 是 `true`），是 bug 的常见来源。

`??` 和 `?.` 在处理 API 返回的数据时非常常用，因为很多字段"可能有、可能没有"。

## 3. 数组

数组是一组有顺序的值。一段对话就是一个"消息数组"。

```ts
const toolNames: string[] = ["read", "write", "edit"];
toolNames.push("bash");          // 加到末尾
toolNames.length;                // 4
toolNames[0];                    // "read"，下标从 0 开始
toolNames.at(-1);                // "bash"，-1 表示最后一个

for (const name of toolNames) {  // 依次取出每个元素
	console.log(name);
}
```

几个必须掌握的数组方法，它们都**不修改原数组**，而是返回新的结果：

```ts
toolNames.map((name) => name.toUpperCase());   // 每个元素变换：["READ", "WRITE", ...]
toolNames.filter((name) => name.length <= 4);  // 只保留满足条件的：["read", "edit", "bash"]
toolNames.find((name) => name.startsWith("e")); // 第一个满足条件的："edit"，找不到是 undefined
toolNames.some((name) => name === "bash");     // 至少一个满足：true
toolNames.every((name) => name.length > 2);    // 全部满足：true
toolNames.join(" / ");                          // 连成字符串："read / write / edit / bash"
const more = [...toolNames, "ls"];             // 展开运算符：复制一份并追加
```

`(name) => name.toUpperCase()` 是一个**箭头函数**，第 5 节会讲。现在你只要知道：`map` 会对每个元素调用这个函数，把返回值收集成新数组。

## 4. 对象和 JSON

对象把多个相关的值组织在一起，每个值有一个名字（叫"属性"或"字段"）：

```ts
const message = {
	role: "user",
	content: "帮我看看 package.json",
	timestamp: Date.now(),   // 当前时间的毫秒数
};

message.role;              // "user"
message["content"];        // 用方括号也可以，字段名是变量时必须用这种写法
Object.keys(message);      // ["role", "content", "timestamp"]

const edited = { ...message, content: "帮我看看 README.md" };  // 复制并修改一个字段
```

最后一行很重要：`{ ...message, content: ... }` 创建了一个**新对象**，`message` 本身没变。在 mini-pi 里，我们经常需要"在旧数据基础上改一点"，同时不破坏旧数据。

### JSON：对象和文本之间的桥梁

**问题**：你的程序要把一条消息发给大模型服务器。但网络上只能传输文本（字节），不能直接传输"对象"。

**解决**：JSON（JavaScript Object Notation）是一种把对象写成文本的格式，几乎所有网络 API 都用它。

```ts
const json = JSON.stringify(message);
// '{"role":"user","content":"帮我看看 package.json","timestamp":1760000000000}'

const parsed = JSON.parse(json);   // 文本变回对象
parsed.content;                    // "帮我看看 package.json"

JSON.stringify(message, null, 2);  // 带缩进的漂亮格式，适合打印给人看
```

和大模型通信的全过程就是：**对象 →`JSON.stringify`→ 文本 → 网络 → 服务器 → 网络 → 文本 →`JSON.parse`→ 对象**。

## 5. 函数

```ts
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
```

- `text: string`：参数和它的类型。
- `): number`：返回值的类型。
- `return`：返回结果并结束函数。

可选参数和默认参数：

```ts
function greet(name: string, greeting = "你好", suffix?: string): string {
	return `${greeting}，${name}${suffix ?? "！"}`;
}
greet("小明");              // "你好，小明！"
greet("Ada", "Hi", ".");    // "Hi，Ada."
```

`greeting = "你好"` 是默认值；`suffix?: string` 表示可以不传，不传时是 `undefined`。

### 箭头函数和回调

另一种写函数的方式：

```ts
const double = (n: number): number => n * 2;
```

**函数也是值**，可以存进变量，也可以作为参数传给别的函数。被传进去、由别人在合适的时候调用的函数，叫做**回调（callback）**：

```ts
function repeat(times: number, action: (index: number) => void): void {
	for (let i = 0; i < times; i++) action(i);
}
repeat(3, (i) => console.log(`第 ${i + 1} 次`));
```

`action: (index: number) => void` 是一个**函数类型**：接收一个 number，不返回值（`void`）。

回调在 mini-pi 里无处不在：比如"每当模型吐出一个字，就调用这个函数把字打印出来"、"每当用户按下一个键，就调用这个函数"。

### 闭包

函数能"记住"它被创建时能看到的变量，即使外面的函数已经执行完了：

```ts
function createIdGenerator(prefix: string): () => string {
	let counter = 0;
	return () => {
		counter++;
		return `${prefix}_${counter}`;
	};
}
const nextId = createIdGenerator("call");
nextId(); // "call_1"
nextId(); // "call_2"
```

`counter` 被返回的箭头函数"关"在了里面，外面访问不到，但每次调用都能读写它。这叫**闭包**。以后我们会用闭包实现"订阅/取消订阅"之类的功能。

## 6. 用类型描述数据：interface 和 type

到目前为止，对象的类型都是自动推断的。当数据结构变复杂时，我们要**给它起个名字**，明确规定它长什么样：

```ts
interface ChatMessage {
	role: string;
	content: string;
	timestamp: number;
	model?: string;          // ? 表示这个字段可有可无
}

const m: ChatMessage = { role: "user", content: "你好", timestamp: Date.now() };
```

有了类型，tsc 会帮你检查：少写了必需字段、字段名拼错、类型不对，都会报错。比如写成 `contnet: "你好"`，tsc 会立刻指出来。

`type` 也能给类型起名字，而且更灵活：

```ts
type Role = "user" | "assistant" | "toolResult";   // 只能是这三个字符串之一
let role: Role = "user";
role = "asistant";   // 错误！tsc：Type '"asistant"' is not assignable to type 'Role'
```

`"user"` 在这里不是普通的 `string`，而是**字面量类型**：只允许这一个值。用 `|` 把几个字面量连起来，就得到"只能是这几个值之一"的类型。这在 pi 里非常常见，比如停止原因 `"stop" | "length" | "toolUse" | "error" | "aborted"`。

`interface` 和 `type` 怎么选？简单的规则：描述对象的形状用 `interface`，其他情况（联合类型、给已有类型起别名）用 `type`。

## 7. 联合类型与类型收窄（本章最重要的一节）

**问题**：一段对话里有三种消息，它们长得不一样：

- 用户消息：有文字。
- 模型消息：可能有文字，也可能有"我要调用 read 工具，参数是 ……"。
- 工具结果：要说明是哪个工具调用的结果（`toolCallId`），以及是否出错。

用一个"大而全"的接口装所有字段吗？那样每个字段都得是可选的，类型就失去了约束力：你没法知道一条消息到底有哪些字段。

**解决**：为每种消息定义一个接口，用一个共同的字段（这里是 `role`）区分它们，然后用 `|` 组合起来：

```ts
interface UserMessage {
	role: "user";
	content: string;
}

interface AssistantMessage {
	role: "assistant";
	content: string;
	toolCalls: { name: string; arguments: Record<string, unknown> }[];
}

interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	content: string;
	isError: boolean;
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

这叫**可辨识联合（discriminated union）**，`role` 是"辨识字段"。

### 类型收窄

拿到一个 `Message` 时，你不知道它具体是哪种。直接访问 `message.toolCalls` 会报错，因为用户消息没有这个字段。你必须先**判断**：

```ts
function describe(message: Message): string {
	switch (message.role) {
		case "user":
			return `用户说：${message.content}`;
		case "assistant":
			return `模型调用了 ${message.toolCalls.length} 个工具`;
		case "toolResult":
			return `工具结果（${message.isError ? "失败" : "成功"}）`;
	}
}
```

神奇的地方在于：在 `case "assistant":` 分支里，TypeScript **自动知道** `message` 是 `AssistantMessage`，所以 `message.toolCalls` 不会报错；而在 `case "user":` 分支里写 `message.toolCalls`，tsc 会报错。这个过程叫**类型收窄（narrowing）**。

`if` 也能收窄：

```ts
if (message.role === "assistant") {
	message.toolCalls;   // 这里是 AssistantMessage
}
```

### 穷尽检查

**问题**：以后你给 `Message` 加了第四种消息，怎么保证所有 `switch` 都处理了它？

**解决**：在 `default` 分支里把值赋给 `never` 类型：

```ts
default: {
	const unreachable: never = message;
	throw new Error(`未知的消息：${JSON.stringify(unreachable)}`);
}
```

`never` 表示"不可能存在的值"。如果所有情况都处理了，走到 `default` 时 `message` 已经被收窄成 `never`，赋值没问题；如果漏了某种消息，`message` 在这里就不是 `never`，tsc 会报错，提醒你补上。

### 其他收窄方式

```ts
function show(value: string | number | string[]) {
	if (typeof value === "string") { /* value 是 string */ }
	else if (typeof value === "number") { /* value 是 number */ }
	else if (Array.isArray(value)) { /* value 是 string[] */ }
}

const block = { type: "text", text: "hi" } as { type: "text"; text: string } | { type: "image"; data: string };
if ("text" in block) { /* block 有 text 字段 */ }
```

### unknown：来路不明的数据

**问题**：`JSON.parse` 返回什么类型？它解析的是网络上收到的文本，内容可能是任何东西。服务器出 bug、协议升级、甚至被人篡改，都可能让数据和你预想的不一样。

TypeScript 里有两个"什么都可能"的类型：

- `any`：关闭类型检查，想怎么用就怎么用。**危险**，等于告诉 tsc"别管我"。
- `unknown`：什么都可能，但**在检查之前什么都不能做**。

```ts
const body: unknown = JSON.parse(text);
body.choices;   // 错误！tsc：'body' is of type 'unknown'

if (typeof body === "object" && body !== null && "choices" in body && Array.isArray(body.choices)) {
	body.choices[0];   // 检查过了，可以用
}
```

> 规则：外部来的数据（网络、文件、用户输入）一律当作 `unknown`，检查之后再使用。pi 的 [AGENTS.md](../../AGENTS.md) 里写着："No `any` unless absolutely necessary"。

有时候你确信数据的形状，可以用 `as` 告诉 tsc"相信我"：`JSON.parse(json) as Message[]`。这叫**类型断言**。它不做任何检查，用错了就会在运行时出问题（还记得里程碑 00 的 `broken.ts` 吗？）。只在你真的确定时使用。

### 类型守卫函数

把"检查"封装成函数，返回类型写成 `value is 某类型`：

```ts
function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return typeof block === "object" && block !== null && "type" in block && block.type === "text";
}
```

调用 `if (isTextBlock(x))` 之后，`x` 就被收窄成那个类型了。配合 `filter` 特别好用：

```ts
const texts = blocks.filter((b): b is TextContent => b.type === "text");  // texts 的类型是 TextContent[]
```

## 8. 泛型：给类型留一个空位

你已经见过 `string[]`。它还有另一种写法：`Array<string>`。尖括号里的 `string` 是一个**类型参数**：`Array` 本身不关心装的是什么，用的时候再指定。

自己写一个泛型函数：

```ts
function last<T>(items: T[]): T | undefined {
	return items[items.length - 1];
}
last([1, 2, 3]);          // T 被推断为 number，返回 number | undefined
last(["a", "b"]);         // T 被推断为 string
```

常见的内置泛型：

| 写法 | 含义 |
| --- | --- |
| `Array<T>` 或 `T[]` | T 的数组 |
| `Promise<T>` | 将来会得到一个 T（下一章讲） |
| `Record<string, T>` | 键是字符串、值是 T 的对象，例如 `Record<string, number>` |

为什么要学泛型？里程碑 06 我们会写一个 `EventStream<T>`，它可以装"模型事件"，也可以装"agent 事件"，靠的就是泛型。

## 9. 类：把数据和操作放在一起

```ts
class Conversation {
	private messages: Message[] = [];   // 字段，private 表示只能在类内部访问
	readonly title: string;             // readonly 表示赋值后不能再改

	constructor(title: string) {        // 构造函数：new 的时候调用
		this.title = title;
	}

	add(message: Message): void {       // 方法
		this.messages.push(message);
	}

	get length(): number {              // getter：用起来像字段，其实是函数
		return this.messages.length;
	}
}

const chat = new Conversation("测试");
chat.add({ role: "user", content: "你好" });
chat.length;       // 1
chat.messages;     // 错误！messages 是 private 的
```

- `this` 指"当前这个对象"。
- 类可以 `implements` 一个接口，承诺"我有这个接口要求的所有东西"。里程碑 17 写终端界面时，每个组件都会 `implements Component`。

> 注意：TypeScript 有一种简写 `constructor(private title: string) {}`，叫"参数属性"。**我们不能用它**，原因见第 12 节。请像上面那样，先声明字段，再在构造函数里赋值。

## 10. 模块：把代码分到多个文件

程序变大后，要分成多个文件。一个文件就是一个**模块**，用 `export` 导出，用 `import` 导入。

`playground/messages.ts`：

```ts
export interface UserMessage { role: "user"; content: string; timestamp: number }
export type Message = UserMessage; // 简化

export function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}
```

`playground/conversation.ts`：

```ts
import type { Message } from "./messages.ts";
import { userMessage } from "./messages.ts";

const messages: Message[] = [userMessage("你好")];
```

两个必须遵守的规则：

**规则一：相对路径要写完整的文件名，包括 `.ts`。** 写成 `"./messages"` 会得到：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/me/my-pi/playground/messages' imported from ...
```

**规则二：只导入类型时，要写 `import type`。**

为什么？回忆一下：Node 运行 `.ts` 文件时会**删掉所有类型**。`interface Message` 被删掉之后，`messages.ts` 根本就没有导出一个叫 `Message` 的东西。如果你写 `import { Message } from "./messages.ts"`，Node 会去找这个不存在的导出：

```
SyntaxError: The requested module './messages.ts' does not provide an export named 'Message'
```

写成 `import type { Message }`，Node 就知道"这一行只是类型，整行删掉即可"。我们在 `tsconfig.json` 里开启的 `verbatimModuleSyntax`，就是让 tsc 提前帮你检查这件事：

```
error TS1484: 'Message' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
```

## 11. 错误处理

程序出错时，可以**抛出**一个错误：

```ts
function divide(a: number, b: number): number {
	if (b === 0) throw new Error("除数不能为 0");
	return a / b;
}
```

抛出的错误会一层层往外传，直到被**捕获**。没被捕获的错误会让程序崩溃（就像里程碑 00 的 `broken.ts`）。

```ts
try {
	divide(1, 0);
	console.log("这一行不会执行");
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.log("出错了：", message);
} finally {
	console.log("不管成功失败，这里都会执行");
}
```

`catch (error)` 里的 `error` 类型是 `unknown`（因为 JavaScript 允许 `throw` 任何东西，比如 `throw "字符串"`）。所以要先用 `instanceof Error` 判断。`error instanceof Error ? error.message : String(error)` 这个写法，你会在 pi 的源码里看到几十次。

> 在 agent 里，错误处理格外重要：网络会断、模型会返回奇怪的东西、工具会执行失败。一个好的 agent **不能因为一个工具出错就崩溃**，而是要把错误告诉模型，让它换个办法。我们会在里程碑 09 实现这一点。

## 12. 不能用的 TypeScript 语法

Node 运行 TypeScript 的方式是"把类型删掉"。但有几种 TypeScript 语法删掉之后，剩下的就不是合法的 JavaScript 了，Node 无法处理：

| 不能用 | 替代写法 |
| --- | --- |
| `enum Color { Red, Green }` | `type Color = "red" \| "green"` |
| `constructor(private name: string) {}` | 先声明字段 `private name: string;`，再在构造函数里 `this.name = name;` |
| `namespace Foo { ... }` | 用模块（单独一个文件） |

用了会得到这样的错误：

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
```

我们 `tsconfig.json` 里的 `erasableSyntaxOnly` 会让 tsc 提前报错：

```
error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
```

pi 项目也遵守同样的规则（见 [AGENTS.md](../../AGENTS.md) 里 "Use only erasable TypeScript syntax" 那一条）。

## 13. 综合项目：用类型描述一段对话

现在把学到的东西组合起来。我们要描述这样一段对话：

```
[用户] 帮我看看 package.json 里写了什么
[助手] 好的，我来读取这个文件。
[助手 → 工具] read({"path":"package.json"})
[工具结果 read] { "name": "my-pi", "type": "module" }
[助手] 这个项目叫 my-pi，并且使用了 ES Module（"type": "module"）。
```

这正是一个 coding agent 工作时对话的样子：模型不是直接回答，而是先**调用工具**获取信息，再根据工具结果回答。

### 13.1 类型：playground/messages.ts

和第 7 节相比，这里更接近真实情况：模型的回复是一个**内容块数组**，一条回复里可以既有文字、又有工具调用。

```ts
/** 一段文字 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 模型请求调用一个工具 */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** 用户说的话 */
export interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

/** 模型的回复：可以同时包含文字和工具调用 */
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ToolCall)[];
	timestamp: number;
}

/** 工具执行完的结果 */
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
	timestamp: number;
}

/** 联合类型：一条消息是这三种之一，用 role 字段区分 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 所有可能的 role，等于 "user" | "assistant" | "toolResult" */
export type Role = Message["role"];

/** 创建一条用户消息的小工具 */
export function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}
```

注意两个细节：

- `(TextContent | ToolCall)[]` 是"元素是 TextContent 或 ToolCall 的数组"。内容块用 `type` 字段区分，又是一个可辨识联合。
- `Message["role"]` 叫**索引访问类型**：取出 `Message` 的 `role` 字段的类型。三种消息的 `role` 合在一起，就是 `"user" | "assistant" | "toolResult"`。这样以后新增消息类型时，`Role` 会自动更新。
- 工具调用有一个 `id`，工具结果用 `toolCallId` 指回它。模型一次可能调用好几个工具，靠 id 才能把结果和调用一一对应起来。

### 13.2 程序：playground/conversation.ts

完整代码见 [code/playground/conversation.ts](code/playground/conversation.ts)。请先尝试自己写，写不出来再看。它包含：

1. 一个 `Message[]` 数组，内容是上面那段对话。
2. `formatMessage(message: Message): string`：用 `switch` 按 `role` 格式化，带穷尽检查。
3. `countByRole(messages)`：统计每种消息的数量，返回 `Record<Role, number>`。
4. `countToolCalls(messages)`：统计工具调用次数。
5. 一个 `Conversation` 类：`add`、`length`、`lastAssistantText()`、`print()`。
6. JSON 往返：`JSON.stringify` 再 `JSON.parse`，确认数据没丢。

关键部分，`formatMessage`：

```ts
function formatMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `[用户] ${message.content}`;
		case "assistant":
			return message.content
				.map((block) => {
					if (block.type === "text") return `[助手] ${block.text}`;
					return `[助手 → 工具] ${block.name}(${JSON.stringify(block.arguments)})`;
				})
				.join("\n");
		case "toolResult": {
			const text = message.content.map((block) => block.text).join("\n");
			const status = message.isError ? "（出错）" : "";
			return `[工具结果 ${message.toolName}${status}] ${text}`;
		}
		default: {
			const unreachable: never = message;
			throw new Error(`未知的消息：${JSON.stringify(unreachable)}`);
		}
	}
}
```

注意 `case "assistant"` 里的 `map` 回调：`if (block.type === "text")` 之后返回了，所以后面那一行里，TypeScript 知道 `block` 一定是 `ToolCall`，可以放心访问 `block.name`。这就是收窄的威力。

运行：

```bash
node playground/conversation.ts
npx tsc
```

期望输出：

```
===== 一段关于 package.json 的对话 =====
[用户] 帮我看看 package.json 里写了什么
[助手] 好的，我来读取这个文件。
[助手 → 工具] read({"path":"package.json"})
[工具结果 read] { "name": "my-pi", "type": "module" }
[助手] 这个项目叫 my-pi，并且使用了 ES Module（"type": "module"）。

统计： { user: 1, assistant: 2, toolResult: 1 }
工具调用次数： 1
最后的回答： 这个项目叫 my-pi，并且使用了 ES Module（"type": "module"）。

JSON 一共 582 个字符，解析回来有 4 条消息
第一条消息： [用户] 帮我看看 package.json 里写了什么
```

（JSON 的字符数会因为时间戳不同而略有差别。）

**试一试**：在 `messages.ts` 里给 `Message` 加一种新消息 `interface SystemMessage { role: "system"; content: string; timestamp: number }`，然后运行 `npx tsc`。tsc 会在哪些地方报错？为什么？（提示：穷尽检查和 `Record<Role, number>`。）

## 14. 练习

练习在 [exercises/](exercises/) 目录，参考答案在 [solutions/](solutions/) 目录。把练习文件复制到你的 `my-pi/playground/` 里，把每个 `throw new Error("TODO...")` 换成你的实现，然后运行它。看到"全部通过"就完成了。

| 练习 | 内容 | 对应章节 |
| --- | --- | --- |
| [ex1-functions.ts](exercises/ex1-functions.ts) | `max`、`formatDuration`、`truncate` | 1~5 |
| [ex2-arrays-objects.ts](exercises/ex2-arrays-objects.ts) | 对消息数组做查找、统计、过滤，并且不修改原数据 | 3~4 |
| [ex3-unions.ts](exercises/ex3-unions.ts) | 处理流式事件的联合类型，穷尽检查 | 7 |
| [ex4-unknown.ts](exercises/ex4-unknown.ts) | 安全地解析 API 响应和工具参数 | 7、11 |
| [ex5-class.ts](exercises/ex5-class.ts) | 泛型队列 `Queue<T>` 和输入历史 `History` | 8~9 |

如果检查失败，你会看到类似这样的输出：

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

'1分5秒' !== '1分05秒'
```

它告诉你：你的函数返回了 `'1分5秒'`，但期望的是 `'1分05秒'`。学会读这种信息，后面写测试时会经常见到。

每个练习做完后都运行一下 `npx tsc`，确保没有类型错误。

## 15. 自测问题

1. `const` 和 `let` 有什么区别？默认应该用哪个？
2. `a ?? b` 和 `a || b` 有什么区别？（提示：当 `a` 是 `0` 或 `""` 时）
3. 下面的代码哪里会报类型错误？为什么？
   ```ts
   function f(m: Message) {
   	if (m.role === "user") return m.toolCallId;
   }
   ```
4. `any` 和 `unknown` 有什么区别？为什么处理网络数据时应该用 `unknown`？
5. 为什么只导入类型时要写 `import type`？不写会发生什么？
6. 为什么不能写 `constructor(private name: string) {}`？
7. 工具调用为什么需要 `id`？

<details>
<summary>参考答案</summary>

1. `const` 不能重新赋值，`let` 可以。默认用 `const`。
2. `??` 只在 `a` 是 `null` 或 `undefined` 时使用 `b`；`||` 在 `a` 是任何"假值"（`0`、`""`、`false`、`null`、`undefined`、`NaN`）时都使用 `b`。比如 `maxTokens ?? 1000`，当用户明确设置 `maxTokens = 0` 时，`??` 会保留 0，`||` 会错误地换成 1000。
3. `m.toolCallId`：在 `m.role === "user"` 分支里，`m` 被收窄成 `UserMessage`，它没有 `toolCallId` 字段。
4. `any` 关闭类型检查，可以随便用；`unknown` 必须先检查才能使用。网络数据的格式不受你控制，用 `unknown` 能强迫你写检查代码，避免运行时崩溃。
5. Node 运行时会删掉类型，被导入的类型在运行时不存在。不写 `import type`，Node 会报 `does not provide an export named ...`。
6. 参数属性需要生成额外的 JavaScript 代码（`this.name = name`），不能简单地"删掉类型"，Node 的 strip-only 模式不支持。
7. 模型一次可能调用多个工具，工具结果要用 id 和对应的调用配对。

</details>

## 16. 对照 pi 源码

打开 [packages/ai/src/types.ts](../../packages/ai/src/types.ts)，搜索 `export interface UserMessage`，你会看到：

```ts
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	// ...
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
```

和我们的 `messages.ts` 几乎一模一样！区别是 pi 的版本多了：

- `ImageContent`（图片）和 `ThinkingContent`（模型的思考过程）两种内容块；
- 助手消息记录了是哪个模型、哪家服务商生成的，用了多少 token（`usage`），为什么停止（`stopReason`）；
- `SystemMessage`（系统提示词，pi 把它也放进了消息列表）。

再搜索 `export type StopReason`：

```ts
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
```

一个典型的字面量联合类型。还有 `AssistantMessageEvent`，它是一个有 12 种事件的可辨识联合（用 `type` 字段区分）——练习 3 就是它的简化版。

这些我们都会在里程碑 06 实现。

## 17. 闭卷挑战

关掉所有参考资料，在一个新文件里从零写出：

1. `TextContent`、`ToolCall`、`UserMessage`、`AssistantMessage`、`ToolResultMessage`、`Message` 六个类型；
2. 带穷尽检查的 `formatMessage`；
3. 一段包含工具调用的示例对话，并打印出来。

然后运行 `npx tsc` 确认没有错误。能在 30 分钟内完成，就说明你已经掌握了本章的核心。

---

上一步：[里程碑 00：准备好你的工作台](../00-setup/README.md) · 下一步：[里程碑 02：异步编程与流](../02-async/README.md)
