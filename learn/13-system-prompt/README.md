# 里程碑 13：系统提示词与命令行（mini-pi v0.1）

> 目标：把前面所有的零件组装成一个每天都能用的命令行程序。系统提示词告诉模型它是谁、该怎么做；`AGENTS.md` 让每个项目带上自己的规矩；print 模式可以在脚本里调用，交互模式可以和它对话。
>
> 完成后你将拥有：**mini-pi v0.1**——一个可以在任何目录下运行的 `mini-pi` 命令。

```
$ cd ~/todo-app
$ mini-pi
mini-pi 0.1.0  模型：deepseek/deepseek-chat
工作目录：/home/you/todo-app
已加载项目说明：/home/you/todo-app/AGENTS.md

你> 测试挂了，帮我看看
> bash $ npm test
  …
  1 failing
> read src/todo.js
> edit src/todo.js（1 处）
  -12   return items.filter(item => item.done)
  +12   return items.filter(item => !item.done)
> bash $ npm test
  12 passing
修好了：src/todo.js 第 12 行的过滤条件写反了。

$ git diff | mini-pi -p "根据这些改动写一条 commit message"
fix: 修正 pendingItems 的过滤条件
```

## 你将学到

- 系统提示词的结构：身份、工具、规则、项目说明、工作目录
- 为什么用 XML 标签给提示词分段，为什么系统提示词要保持稳定
- `AGENTS.md`：给每个项目写一份说明书
- 用 `node:util` 的 `parseArgs` 解析命令行参数
- print 模式和交互模式；标准输出、标准错误和退出码
- 依赖注入：让交互模式可以在测试里运行
- 端到端测试：像用户一样运行整个程序

---

## 1. 问题：零件齐了，还不是一个产品

到上一章为止，我们有了 ai 层、agent 循环和五个工具。但每个 demo 都有自己临时拼凑的系统提示词和启动代码，而且：

- 模型不知道自己在哪个项目里、这个项目用什么命令跑测试、代码风格是什么样的；
- 工具的使用规则（比如"修改文件前先读一遍"）散落在各个 demo 里；
- 只能在 `my-pi` 目录里运行 `node playground/xxx.ts`，没法在别的项目里用。

这一章把它们组装成一个真正的程序。

## 2. 系统提示词

### 2.1 结构

[code/src/core/system-prompt.ts](code/src/core/system-prompt.ts) 的 `buildSystemPrompt` 生成的系统提示词是这样的（假设在一个有 `AGENTS.md` 的项目里运行）：

```
你是一个专业的编程助手，运行在 mini-pi（一个 coding agent）中。你通过读取文件、执行命令、修改代码和创建新文件来帮助用户。

<tools>
- read: 读取文件内容
- bash: 执行 bash 命令（ls、grep、find 等）
- edit: 用精确的文字替换修改文件，一次可以修改多处
- write: 创建或覆盖文件
- ls: 列出目录内容
</tools>

<rules>
- 查看文件用 read，不要用 cat 或 sed
- 用 edit 做精确的修改（edits[].oldText 必须和文件内容完全一致）
- 同一个文件要改多处时，只调用一次 edit，把每一处都放进 edits，而不是调用多次
- 每个 oldText 都在原文件里查找，而不是在前面的修改之后。不要让各处修改重叠，离得近的修改合并成一处
- oldText 在保证唯一的前提下尽量短，不要包含大段没有改动的内容
- write 只用于创建新文件或者完全重写
- 回答要简洁
- 涉及文件时，清楚地写出文件路径
</rules>

<project_context>
项目的说明和规范：

<project_instructions path="/home/you/todo-app/AGENTS.md">
# todo-app

- 运行测试：npm test
- 代码风格：两个空格缩进，不用分号
</project_instructions>
</project_context>

<cwd>
/home/you/todo-app
</cwd>
```

五个部分，各有用途：

| 部分 | 作用 |
| --- | --- |
| 开头一句话 | 身份：你是谁、你的工作方式 |
| `<tools>` | 每个工具一句话的概览。详细的参数说明在工具定义里（里程碑 08），这里让模型对"手里有什么"有个整体印象 |
| `<rules>` | 怎样用好工具。比如"查看文件用 read，不要用 cat"：read 有截断和分页，`cat` 一个大文件会把几万行塞进上下文 |
| `<project_context>` | 项目的说明文件（第 3 节） |
| `<cwd>` | 工作目录。模型需要知道相对路径相对于哪里 |

规则是根据启用的工具生成的：只启用 `read` 和 `ls` 时，就不会出现 `edit` 的规则。每个内置工具的介绍和规则记在一张表里：

```ts
const TOOL_PROMPTS: Record<string, { snippet: string; guidelines: string[] }> = {
	read: {
		snippet: "读取文件内容",
		guidelines: ["查看文件用 read，不要用 cat 或 sed"],
	},
	// ……
};
```

不在表里的工具（比如你以后自己加的工具），用它的 `description` 代替。

### 2.2 为什么规则和工具描述有重复？

`edit` 的描述里已经说了"oldText 必须唯一、不能重叠"，系统提示词里又说了一遍。这是故意的：工具描述是在"考虑要不要用这个工具、参数怎么填"的时候看的；系统提示词是"整体的工作方式"。重要的规则在两个地方都出现，模型更不容易忘。pi 也是这样做的：每个工具除了 `description`，还有 `promptSnippet`（一句话介绍）和 `promptGuidelines`（使用规则）。

### 2.3 为什么用 XML 标签？

`<tools>…</tools>`、`<project_instructions path="…">…</project_instructions>` 这样的标签让模型清楚地看出每一部分从哪里开始、到哪里结束。尤其是 `AGENTS.md` 的内容是用户写的，可能包含各种标题和列表，用标签包起来，模型就不会把它和我们自己的规则混在一起。主流的模型都很擅长理解这种结构。

### 2.4 系统提示词要保持稳定

里程碑 06 讲过 token 用量里的"缓存"：服务商会缓存请求的**开头部分**，下次请求如果开头完全一样，这部分就便宜得多，速度也更快。系统提示词是每个请求的开头。如果它每次都变（比如在里面写上当前的时间，精确到秒），缓存就永远用不上。

所以系统提示词在程序启动时生成一次，之后整个对话都不变。pi 的系统提示词里甚至没有当前日期。（练习 1 会讨论加上日期的利弊。）

## 3. AGENTS.md：项目的说明书

### 3.1 写什么？

每个项目都有自己的规矩。比如这个课程所在的 pi 仓库，根目录的 `AGENTS.md` 里写着："修改代码之后运行 `npm run check`"、"不要用 `any` 类型"、"提交时只添加你自己修改的文件"……一个好的 `AGENTS.md` 通常包括：

- 怎样构建、测试、检查代码（具体的命令）；
- 代码风格和约定；
- 项目结构：哪个目录放什么；
- 不能做的事："不要修改 `generated/` 目录"、"不要提交 `.env`"。

`AGENTS.md` 是很多 coding agent 共同支持的约定，Claude Code 读的是 `CLAUDE.md`。我们两个都认，同一个目录里优先用 `AGENTS.md`。

### 3.2 去哪里找？

[code/src/core/context-files.ts](code/src/core/context-files.ts)：

```ts
export function loadContextFiles(cwd: string, agentDir: string): ContextFile[] {
	const files: ContextFile[] = [];
	const global = loadFromDir(agentDir);
	if (global) files.push(global);

	const ancestors: ContextFile[] = [];
	let dir = resolve(cwd);
	while (true) {
		const file = loadFromDir(dir);
		if (file && file.path !== global?.path) ancestors.unshift(file); // 加在前面：根目录的排在最前
		const parent = dirname(dir);
		if (parent === dir) break; // 到根目录了
		dir = parent;
	}
	return [...files, ...ancestors];
}
```

加载顺序：

1. **全局**：`~/.mini-pi/AGENTS.md`，写你个人的习惯，对所有项目都有效（比如"总是用中文回答"）。
2. **从根目录到当前目录的每一层**：比如在 `~/work/monorepo/packages/web` 里运行，会依次加载 `~/work/AGENTS.md`、`~/work/monorepo/AGENTS.md`、`~/work/monorepo/packages/web/AGENTS.md`（存在的话）。

**越具体的越靠后。** 当两条规则冲突时，模型通常更重视后面出现的那条。所以子目录的规则能"覆盖"上层目录的规则，项目的规则能"覆盖"你的个人习惯。

`while (true)` 加上"父目录等于自己时停止"是向上遍历目录的标准写法：根目录 `/` 的父目录还是 `/`。

### 3.3 安全提醒

`AGENTS.md` 的内容会原封不动地进入系统提示词。如果你从网上克隆了一个陌生的仓库，它的 `AGENTS.md` 里可能藏着恶意的指令（还记得里程碑 12 的提示词注入吗）。pi 的安全文档专门提醒：即使你没有"信任"这个项目，也要把目录里的说明当作不可信的输入。

## 4. 命令行参数：parseArgs

从 Node.js 18 开始，标准库里就有一个解析命令行参数的函数 `parseArgs`，不需要安装任何依赖。[code/src/cli/args.ts](code/src/cli/args.ts)：

```ts
parseArgs({
	args: argv,
	allowPositionals: true,
	strict: true, // 遇到不认识的参数就报错，而不是悄悄忽略
	options: {
		help: { type: "boolean", short: "h" },
		print: { type: "boolean", short: "p" },
		mode: { type: "string" },
		model: { type: "string", short: "m" },
		"append-system-prompt": { type: "string", multiple: true },
		tools: { type: "string", short: "t" },
		"no-tools": { type: "boolean" },
		// ……
	},
});
```

- `type: "boolean"` 的参数后面不跟值（`-p`），`type: "string"` 的后面跟一个值（`--model deepseek/deepseek-chat`）。
- `multiple: true` 允许出现多次，结果是一个数组。
- 不是参数的部分叫**位置参数**（positionals），比如 `mini-pi -p "你好"` 里的 `"你好"`。以 `@` 开头的位置参数是文件（`@src/main.ts`），其余的是消息。
- `strict: true` 让拼错的参数（`--modle`）直接报错。悄悄忽略的话，用户会困惑"为什么我指定的模型没生效"。

`parseCliArgs` 把 `parseArgs` 的结果整理成一个类型清楚的 `CliArgs` 对象，后面的代码只和它打交道。

## 5. 组装：cli.ts

[code/src/cli.ts](code/src/cli.ts) 是程序的入口，`main` 函数从上到下就是组装的过程：

```ts
const args = parseCliArgs(argv);
if (args.help) { /* 显示帮助 */ }

// ~/.mini-pi/.env 里可以放 API key 和默认模型。环境变量里已有的值优先
const envFile = join(getAgentDir(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cwd = process.cwd();
const model = resolveModel(args.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
const allTools = createCodingTools(cwd);
const tools = args.noTools ? [] : args.tools ? selectTools(allTools, args.tools) : allTools;
const contextFiles = loadContextFiles(cwd, getAgentDir());
const systemPrompt = buildSystemPrompt({ cwd, tools, contextFiles, /* …自定义提示词… */ });
const agent = new Agent({ model, systemPrompt, tools });

// 输入或输出被管道连接时（不是终端），自动使用 print 模式
const print = args.print || !process.stdin.isTTY || !process.stdout.isTTY;
```

几个值得注意的地方：

- **`process.cwd()` 就是工作目录**：你在哪个目录里运行 `mini-pi`，它就在哪个目录里工作。所有工具都用这个目录创建。
- **`process.loadEnvFile`**：Node.js 自带的读取 `.env` 文件的函数。以前我们要写 `node --env-file=.env ...`，现在把 API key 放在 `~/.mini-pi/.env` 里，在任何目录运行都能读到。已经存在的环境变量不会被覆盖。
- **`getAgentDir()`**（在 [code/src/core/config.ts](code/src/core/config.ts) 里）默认是 `~/.mini-pi`，可以用环境变量 `MINI_PI_DIR` 换一个地方。测试时会用到。
- **版本号从 `package.json` 里读取**：`new URL("../../package.json", import.meta.url)` 是"相对于当前源文件"的路径，不管你在哪个目录运行程序都能找到。
- **文件的第一行 `#!/usr/bin/env node`**：叫做 shebang，告诉系统"用 node 运行这个文件"，这样它可以直接作为命令执行。
- **出错时**：`main` 外面的 `try/catch` 把错误信息打印到标准错误，退出码设为 1，而不是打印一大段调用栈吓唬用户。

`--system-prompt` 和 `--append-system-prompt` 的值可以是文字，也可以是文件路径：如果这个路径的文件存在，就读取文件的内容（`readTextOrFile`）。长的提示词放在文件里更方便。

## 6. print 模式

### 6.1 输出、错误和退出码

[code/src/modes/print.ts](code/src/modes/print.ts)：

```ts
for (const message of options.messages) {
	await agent.prompt(message);
}

const last = agent.state.messages.at(-1);
if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
	// 错误信息写到标准错误，退出码 1：调用这个程序的脚本能知道出错了
	console.error(last.errorMessage ?? `请求失败（${last.stopReason}）`);
	return 1;
}
if (options.mode === "text" && last?.role === "assistant") {
	process.stdout.write(`${text}\n`);   // 只输出最终的回答
}
return 0;
```

命令行程序有三个和外界沟通的渠道：

- **标准输出**：程序的"结果"。print 模式只输出最终的回答，这样 `mini-pi -p "..." > answer.txt` 得到的文件里干干净净。
- **标准错误**：给人看的错误和提示信息。即使标准输出被重定向到文件，错误信息仍然显示在屏幕上。
- **退出码**：0 表示成功，其他表示失败。脚本里可以写 `mini-pi -p "..." || echo "出错了"`。

`--mode json` 把每个事件作为一行 JSON 输出。其他程序可以读取这些事件，做出自己的界面——这是里程碑 09 用事件来设计 agent 循环的又一个回报。

### 6.2 管道和 @文件

`cli.ts` 的 `buildMessages` 把三样东西合成第一条消息：管道输入的内容、`@文件` 的内容、第一条消息：

```bash
cat error.log | mini-pi -p "这是什么错误？"
mini-pi -p @src/main.ts @src/utils.ts "这两个文件有什么关系？"
git diff | mini-pi -p "根据这些改动写一条 commit message"
```

文件内容用 `<file name="…">…</file>` 包起来，和系统提示词里的做法一样。

什么时候读标准输入？只在它**不是终端**的时候（`process.stdin.isTTY` 为假），也就是被管道连接时。如果在终端里也去读标准输入，程序会一直等你输入，直到你按 Ctrl+D。

## 7. 交互模式

[code/src/modes/repl.ts](code/src/modes/repl.ts) 就是前几章的 `coding-agent.ts`：插话、排队、Ctrl+C 打断、危险命令确认，搬进了 `src/modes/` 并整理成一个函数：

```ts
export interface ReplOptions {
	input?: NodeJS.ReadableStream;   // 默认 process.stdin
	output?: NodeJS.WritableStream;  // 默认 process.stdout
	confirmDangerous?: boolean;
	banner?: string[];
	initialMessages?: string[];
}

export function runReplMode(agent: Agent, options: ReplOptions = {}): Promise<void>
```

两个设计上的变化：

**输入和输出可以替换。** 默认是终端，测试时可以换成内存里的流。这叫做**依赖注入**：函数不自己去拿它依赖的东西（`process.stdin`），而是由调用者传进来。这样就能在测试里"模拟用户打字"：

```ts
const input = new PassThrough();    // 往这里写，就是用户在打字
const output = new PassThrough();   // 从这里读，就是屏幕上显示的内容
const done = runReplMode(agent, { input, output });
input.write("删掉 build 目录\n");
await terminal.waitFor("允许执行吗？");
input.write("n\n");
```

（见 `test/repl.test.ts`。）

**确认危险命令由交互模式负责。** `runReplMode` 设置 `agent.beforeToolCall`。print 模式没有人可以回答问题，所以不设置——和 pi 一样，危险命令不确认。在脚本里使用 agent 时，请记住里程碑 12 的建议：用 git，或者在容器里运行。

`runReplMode` 返回一个 Promise，用户退出时完成。它不调用 `process.exit()`，什么时候退出由调用者决定。这也是为了能测试：测试里调用 `process.exit()` 会把整个测试程序都退出。

## 8. 安装成命令

想在任何目录下输入 `mini-pi` 就能运行？两种办法：

**办法一：别名（推荐）。** 在 `~/.bashrc`（或 `~/.zshrc`）里加一行：

```bash
alias mini-pi="node ~/my-pi/src/cli.ts"
```

**办法二：`npm link`。** `package.json` 里已经写了：

```json
"bin": { "mini-pi": "src/cli.ts" }
```

在 `my-pi` 目录里运行 `npm link`，npm 会创建一个全局的 `mini-pi` 命令，指向你的 `src/cli.ts`。

然后把 API key 和默认模型写进 `~/.mini-pi/.env`：

```bash
mkdir -p ~/.mini-pi
cat > ~/.mini-pi/.env <<'EOF'
DEEPSEEK_API_KEY=sk-你的key
MINI_PI_MODEL=deepseek/deepseek-chat
EOF
```

再给自己写一个全局的 `~/.mini-pi/AGENTS.md`，比如"总是用中文回答，代码注释也用中文"。

现在找一个你自己的项目，`cd` 进去，运行 `mini-pi`。从今天起，你可以用自己写的 coding agent 干活了。

## 9. 端到端测试

前面的测试都是测一个函数、一个类。**端到端测试**（end-to-end，简称 e2e）像用户一样运行整个程序，检查最终的结果。[code/test/cli.test.ts](code/test/cli.test.ts)：

```ts
test("调用工具：在当前目录里写文件，再给出回答", async (t) => {
	const { dir, env, server } = await setup(t, [
		{ chunks: [toolCallChunk(0, { id: "call_1", name: "write", args: '{"path":"hello.txt","content":"你好"}' }), finishChunk("tool_calls")] },
		{ chunks: [textChunk("写好了"), finishChunk("stop")] },
	]);
	const result = await runCli([...MODEL, "-p", "创建 hello.txt"], { cwd: dir, env });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "写好了\n");
	assert.equal(await readFile(join(dir, "hello.txt"), "utf-8"), "你好");
});
```

它把所有零件都串了起来：

1. 启动一个假的模型服务器（里程碑 07 的 `test/helpers/fake-server.ts`），准备好两次响应；
2. 用 `--model custom/test-model` 加上环境变量 `LLM_BASE_URL` 让 mini-pi 连接这个假服务器；
3. 在一个临时目录里**真的运行** `node src/cli.ts`（`test/helpers/run-cli.ts`）；
4. 检查标准输出、退出码，以及文件是不是真的被写出来了。

注意 `runCli` 给子进程一个"干净"的环境：只有 `PATH` 和测试指定的变量，`HOME` 指向临时目录。否则你电脑上的 `MINI_PI_MODEL`、`~/.mini-pi/AGENTS.md` 会影响测试结果，测试在你的电脑上通过、在别人的电脑上失败。

端到端测试比单元测试慢（每个都要启动一个新进程），但它能发现"每个零件都没问题，组装起来却不工作"的 bug。

## 10. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/core/config.ts` | `APP_NAME`、`VERSION`、`getAgentDir()` |
| `src/core/context-files.ts` | `ContextFile`、`loadContextFiles(cwd, agentDir)` |
| `src/core/system-prompt.ts` | `BuildSystemPromptOptions`、`buildSystemPrompt(options)` |
| `src/cli/args.ts` | `CliArgs`、`parseCliArgs(argv)`、`helpText()` |
| `src/modes/print.ts` | `runPrintMode(agent, { mode, messages })`，返回退出码 |
| `src/modes/repl.ts` | `runReplMode(agent, options)`、`summarizeArgs(toolName, args)` |
| `src/cli.ts` | 入口 |
| `package.json` | 版本 0.1.0；`bin`；`start` 脚本 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `system-prompt.test.ts`、`context-files.test.ts`、`args.test.ts`、`repl.test.ts`、`cli.test.ts`，以及辅助文件 `test/helpers/run-cli.ts`。一共 197 个测试。

## 11. 常见错误

| 现象 | 原因 |
| --- | --- |
| 在别的目录运行，工具却在 `my-pi` 目录里读写文件 | 用了固定的目录，而不是 `process.cwd()` |
| 在终端里运行 `mini-pi -p "你好"`，程序一直不动 | 在终端里也去读标准输入了，程序在等你输入。只在 `!process.stdin.isTTY` 时读 |
| `mini-pi -p "..." > a.txt` 得到的文件里混着工具调用的过程 | print 模式应该只往标准输出写最终回答 |
| 脚本里没法判断 mini-pi 有没有出错 | 出错时退出码仍然是 0，或者错误信息写到了标准输出 |
| `AGENTS.md` 写了规则，模型好像没看见 | 检查启动信息里有没有"已加载项目说明"；文件名的大小写；你是不是在项目的子目录之外运行的 |
| 测试在你的电脑上通过，在别人的电脑上失败 | 测试受到了你电脑上的环境变量或 `~/.mini-pi` 里的文件的影响 |
| 拼错了参数（`--modle`），程序却照常运行 | `parseArgs` 没有设置 `strict: true` |

## 12. 练习

1. **环境信息**：给系统提示词加一个 `<environment>` 部分，写上操作系统（`process.platform`）和今天的日期。想一想：日期每天变一次，对缓存有什么影响？如果精确到分钟呢？
2. **列出模型**：加一个 `--list-models` 参数，列出 `PROVIDERS` 里所有服务商的所有内置模型，以及每个服务商需要的环境变量。（pi 有一个同名的参数。）
3. **个人覆盖**：pi 在每个目录里最先找的是 `AGENTS.override.md`。它适合放"只对我自己有效、不提交到 git 的项目规则"。给 `loadContextFiles` 加上它。
4. **写你自己的 AGENTS.md**：给你的 `my-pi` 项目写一个 `AGENTS.md`（怎样运行测试、代码风格、项目结构），然后在 `my-pi` 里运行 `mini-pi`，让它"给 ls 工具加一个 depth 参数"。观察它是否遵守了你的规则。
5. **`--api-key`**：加一个 `--api-key` 参数，优先于环境变量。提示：`Agent` 的 `getApiKey` 选项。
6. **思考题**：为什么交互模式在输入或输出不是终端时要自动切换成 print 模式？如果不切换，`echo "你好" | mini-pi` 会发生什么？

## 13. 自测问题

1. 系统提示词由哪几部分组成？每部分的作用是什么？
2. 为什么系统提示词要在启动时生成一次，之后保持不变？
3. `AGENTS.md` 的加载顺序是什么？为什么越具体的越靠后？
4. 标准输出和标准错误分别用来输出什么？为什么出错时退出码不能是 0？
5. 什么时候读取标准输入？为什么不能总是读？
6. 什么是依赖注入？`runReplMode` 为什么要允许替换输入和输出？
7. 端到端测试为什么要给子进程一个"干净"的环境？

<details>
<summary>参考答案</summary>

1. 身份（开头一句话）、工具概览、使用规则、项目说明、工作目录。分别告诉模型它是谁、手里有什么、怎样用好工具、这个项目的规矩、相对路径相对于哪里。
2. 服务商缓存请求的开头部分，系统提示词是每个请求的开头。它保持不变，缓存才能命中，请求才更便宜、更快。
3. 先全局的 `~/.mini-pi/AGENTS.md`，再从根目录到当前目录的每一层。规则冲突时模型通常更重视后面的，所以越具体的放在越后面，能覆盖更一般的规则。
4. 标准输出是程序的结果，标准错误是给人看的错误和提示。退出码是脚本判断成功与否的依据，出错时必须不是 0。
5. 只在标准输入不是终端（被管道连接）时读。在终端里读的话，程序会一直等用户输入。
6. 函数不自己获取它依赖的东西，而是由调用者传进来。替换成内存里的流之后，测试可以模拟用户输入、检查屏幕输出，不需要真的终端。
7. 否则测试结果会受到运行测试的那台电脑上的环境变量和配置文件影响，在一台电脑上通过、在另一台上失败。

</details>

## 14. 对照 pi 源码

- **系统提示词**：[packages/coding-agent/src/core/system-prompt.ts](../../packages/coding-agent/src/core/system-prompt.ts) 的 `buildSystemPromptSections`。结构和我们的一样：开头一句话（"You are an expert coding assistant operating inside pi..."）、`<tools>`、`<rules>`（`buildRules`，最后两条也是 "Be concise in your responses" 和 "Show file paths clearly when working with files"）、`<project_context>`（`<project_instructions path="...">`）、`<cwd>`。pi 还有 `<docs>`（pi 自己的文档在哪里，用户问到 pi 本身时去读）和 `<skills>`（技能，按需加载的说明书）。
- **工具的提示词**：pi 的每个工具定义里有 `promptSnippet` 和 `promptGuidelines`，比如 [read.ts](../../packages/coding-agent/src/core/tools/read.ts) 里的 `readToolSystemPromptContribution`。我们用一张表代替。
- **说明文件**：[resource-loader.ts](../../packages/coding-agent/src/core/resource-loader.ts) 的 `loadProjectContextFiles` 和 `loadContextFileFromDir`：先全局（`~/.pi/agent/`），再从当前目录往上找，用 `unshift` 让根目录的排在前面——和我们的写法一模一样。候选文件名依次是 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。它还处理了 git worktree 的特殊情况（避免同一份说明被加载两次）。
- **命令行参数**：[cli/args.ts](../../packages/coding-agent/src/cli/args.ts) 手写了一个循环来解析参数（没有用 `parseArgs`），支持的参数多得多：会话相关的 `--continue`、`--resume`（下一章）、`--thinking`、`--extension` 等。`printHelp` 列出了全部参数。
- **入口**：[main.ts](../../packages/coding-agent/src/main.ts)。`resolveAppMode` 决定运行模式：`--mode json`、`--print`，或者标准输入/输出不是终端时，用 print 模式——和我们一样。`readPipedStdin` 读取管道输入；[cli/initial-message.ts](../../packages/coding-agent/src/cli/initial-message.ts) 的 `buildInitialMessage` 把管道输入、`@文件` 和第一条消息合在一起；[cli/file-processor.ts](../../packages/coding-agent/src/cli/file-processor.ts) 用 `<file name="...">` 包住文件内容（图片作为附件）。
- **print 模式**：[modes/print-mode.ts](../../packages/coding-agent/src/modes/print-mode.ts)：依次发送消息；text 模式输出最后一条助手消息的文字，出错时写标准错误、退出码 1；json 模式每个事件输出一行。还处理了 `SIGTERM`、`SIGHUP` 信号：先终止正在运行的子进程，再退出。
- **安全**：[docs/security.md](../../packages/coding-agent/docs/security.md) 的 "Understand project trust" 一节：pi 加载项目里的设置、扩展之前会先问你是否信任这个项目；但 `AGENTS.md` 这类说明文件无论如何都会加载，所以要把它们当作不可信的输入。

## 15. 闭卷挑战

不看资料，写出：

1. `buildSystemPrompt`；
2. `loadContextFiles`（向上遍历目录）；
3. `cli.ts` 的 `main` 函数：解析参数 → 组装 agent → 选择模式；
4. `runPrintMode`（输出、错误、退出码）。

让 `test/system-prompt.test.ts`、`test/context-files.test.ts` 和 `test/cli.test.ts` 全部通过。

---

**恭喜！你完成了 mini-pi v0.1。** 回头看一看：从第一次用 `fetch` 调用模型，到现在一个能读代码、改代码、跑测试的 coding agent，每一行代码都是你自己写的。

下一阶段要解决两个实际使用中马上会遇到的问题：关掉程序，对话就没了（**会话**）；对话越来越长，终于超出了上下文窗口（**压缩**）。

上一步：[里程碑 12：bash 工具](../12-bash/README.md) · 下一步：[里程碑 14：会话](../14-sessions/README.md)
