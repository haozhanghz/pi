# 里程碑 00：准备好你的工作台

> 目标：装好写代码需要的工具，学会用终端，跑起你的第一个 TypeScript 程序，并建立你自己的项目 `my-pi`。
>
> 完成后你将拥有：一个能运行、能做类型检查、被 git 管理的空项目。后面 20 个里程碑都在这个项目里完成。

## 你将学到

- 什么是终端（terminal），最常用的十个命令
- 安装 Node.js 和 VS Code
- 运行一个 `.ts` 文件；`package.json` 和 `tsconfig.json` 是做什么的
- "运行"和"类型检查"是两件不同的事
- 用 git 给代码存档
- 读懂报错信息，用 `console.log` 和调试器找问题
- 不靠 AI 时去哪里查资料

---

## 1. 这门课最终要做出什么

先看终点，再出发。

**coding agent（编程智能体）** 是这样一个程序：你用自然语言告诉它"帮我给这个函数加上单元测试"，它就会自己去**读文件、改文件、运行命令**，一步一步完成任务，最后告诉你做了什么。[pi](../../README.md) 就是这样一个 coding agent，这门课就是要带你从零写出一个它的"迷你版"——我们叫它 **mini-pi**。

一个 coding agent 的核心其实非常简单，可以用一句话说清：

```
循环 {
    把"对话历史 + 可用工具列表"发给大模型
    如果大模型说"我要调用某个工具"：执行工具，把结果加入对话历史，继续循环
    否则：大模型给出了最终回答，结束
}
```

这就是所谓的 **Agent Loop（智能体循环）**。整门课 80% 的内容都是在把这个循环的每个部分做扎实、做漂亮：怎么和大模型通信、怎么流式显示、工具怎么定义、怎么保存会话、上下文太长怎么办、终端界面怎么做得流畅……

但在这之前，你得先有一个能写代码的工作台。

## 2. 你需要准备的东西

| 东西 | 作用 | 版本要求 |
| --- | --- | --- |
| 一台电脑 | macOS、Linux 都可以；Windows 请使用 WSL2（见下文） | — |
| 终端 | 输入命令的地方 | 系统自带即可 |
| Node.js | 运行 JavaScript / TypeScript 代码 | **22.18 或更高**，推荐 24 LTS |
| VS Code | 写代码的编辑器 | 最新版 |
| git | 给代码存档 | 任意较新版本 |

> **Windows 用户**：请安装 [WSL2](https://learn.microsoft.com/zh-cn/windows/wsl/install)（在 PowerShell 里运行 `wsl --install`，重启后会得到一个 Ubuntu 系统），之后所有命令都在 WSL 的终端里运行。原因是：我们的 agent 在第 12 个里程碑会通过 `bash` 执行命令，而 Windows 原生没有 bash。用 WSL 可以让你和 macOS/Linux 的同学完全一致。

## 3. 终端入门

### 3.1 终端是什么

终端是一个"用文字和电脑对话"的窗口。你输入一行命令，按回车，电脑执行它并把结果打印出来。

- macOS：打开"终端"（Terminal）应用，或者在 VS Code 里按 `` Ctrl+` ``。
- Linux：打开 Terminal。
- Windows：打开 WSL（开始菜单里的 Ubuntu）。

终端里运行的那个"理解你命令的程序"叫做 **shell**，最常见的是 `bash` 和 `zsh`。你不用关心区别，下面的命令在两者里都一样。

### 3.2 最常用的十个命令

打开终端，逐个试一遍（`#` 后面是说明，不用输入）：

```bash
pwd                 # 我现在在哪个目录（print working directory）
ls                  # 列出当前目录里的文件
ls -la              # 列出所有文件，包括隐藏文件，并显示详细信息
mkdir demo          # 创建一个叫 demo 的目录
cd demo             # 进入 demo 目录
cd ..               # 回到上一级目录
echo "你好" > a.txt # 把"你好"写进文件 a.txt
cat a.txt           # 显示文件内容
rm a.txt            # 删除文件（不会进回收站，小心！）
clear               # 清屏
```

几个必须记住的概念：

- **路径（path）**：文件的地址。`/home/me/my-pi/hello.ts` 是**绝对路径**（从根目录 `/` 开始）；`my-pi/hello.ts` 是**相对路径**（从当前目录开始）。
- 特殊路径：`.` 是当前目录，`..` 是上一级目录，`~` 是你的家目录（home）。
- **Tab 补全**：输入文件名的前几个字母后按 `Tab`，shell 会自动补全。多用它，能少打很多字，也能避免拼错。
- **上方向键**：调出上一条命令。
- **Ctrl+C**：中止正在运行的程序。程序卡住了就按它。

> 小提示：后面课程里出现的所有命令，都是在终端里输入的。看到 `$` 开头的行，`$` 本身不用输入。

## 4. 安装 Node.js

**Node.js** 是一个能在你电脑上运行 JavaScript 的程序。浏览器里能跑 JavaScript，Node.js 让 JavaScript 也能在浏览器之外运行，读写文件、发网络请求、启动其他程序——这正是一个 coding agent 需要的能力。pi 就是用 Node.js 写的。

从 Node.js 22.18 开始，Node 可以**直接运行 TypeScript 文件**（它会先把类型标注去掉再执行），所以我们不需要任何编译步骤。这让入门简单了很多。

安装方法（任选一种）：

1. **官方安装包**：到 [nodejs.org](https://nodejs.org/zh-cn) 下载 LTS 版本安装。
2. **版本管理器**（推荐，方便以后升级）：例如 [fnm](https://github.com/Schniz/fnm)。
   ```bash
   # macOS / Linux / WSL
   curl -fsSL https://fnm.vercel.app/install | bash
   # 重新打开终端后：
   fnm install 24
   fnm use 24
   ```

> **中国大陆网络提示**：如果下载很慢，可以给 fnm 设置镜像：`export FNM_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node`；给 npm 设置镜像：`npm config set registry https://registry.npmmirror.com`。

安装完成后验证：

```bash
node --version    # 应该显示 v22.18.0 或更高，例如 v24.11.0
npm --version     # npm 是 Node 自带的包管理器
```

如果显示 `command not found`，说明没装好或者需要重新打开终端。

## 5. 安装 VS Code

到 [code.visualstudio.com](https://code.visualstudio.com/) 下载安装。VS Code 内置了 TypeScript 支持：鼠标悬停能看到类型，写错了会画红色波浪线。

建议打开两个设置（`设置` 里搜索）：

- `Format On Save`：保存时自动整理代码格式。
- `Auto Save`：自动保存（可选）。

WSL 用户：安装 VS Code 的 "WSL" 扩展，然后在 WSL 终端里进入项目目录，运行 `code .` 就能用 VS Code 打开 WSL 里的文件。

## 6. 建立你的项目 my-pi

这是你接下来几个月都会使用的项目。我们把它放在家目录下：

```bash
cd ~
mkdir my-pi
cd my-pi
mkdir playground
```

`playground`（游乐场）目录用来放前几个里程碑的练习脚本。从里程碑 06 开始，正式的 mini-pi 代码会放在 `src` 目录。

### 6.1 第一个程序

用 VS Code 打开 `my-pi` 目录（`code .`），新建文件 `playground/hello.ts`，输入下面的内容。**请自己一个字一个字敲，不要复制粘贴**——敲代码的过程本身就是学习，你会注意到很多复制时会忽略的细节。

```ts
// 你的第一个程序。运行：node playground/hello.ts
const name: string = "mini-pi";

console.log(`你好，${name}！`);
console.log("现在的 Node.js 版本是：", process.version);
console.log("当前所在的目录是：", process.cwd());
```

在终端里运行（确保当前目录是 `my-pi`）：

```bash
node playground/hello.ts
```

你应该看到类似这样的输出：

```
你好，mini-pi！
现在的 Node.js 版本是： v24.11.0
当前所在的目录是： /home/me/my-pi
```

逐行解释：

- `//` 开头的是**注释**，给人看的，电脑会忽略。
- `const name: string = "mini-pi";` 声明一个叫 `name` 的**常量**，它的**类型**是 `string`（字符串），值是 `"mini-pi"`。`: string` 这部分就是 TypeScript 的"类型标注"。
- `console.log(...)` 把内容打印到终端。
- `` `你好，${name}！` `` 用反引号包起来的是**模板字符串**，`${...}` 里的表达式会被替换成它的值。
- `process` 是 Node.js 提供的一个全局对象，代表"当前这个正在运行的程序"。`process.version` 是 Node 的版本，`process.cwd()` 是当前工作目录（current working directory）。

### 6.2 package.json：项目的身份证

在 `my-pi` 目录运行：

```bash
npm init -y
```

它会生成一个 `package.json` 文件。打开它，加上一行 `"type": "module"`，变成类似这样：

```json
{
	"name": "my-pi",
	"version": "0.0.1",
	"private": true,
	"type": "module"
}
```

`package.json` 描述了这个项目：名字、版本、依赖哪些第三方包、有哪些常用命令。

`"type": "module"` 的意思是"这个项目里的文件使用 **ES Module** 语法"，也就是 `import` / `export`。这是现代 JavaScript 组织代码的标准方式，下一个里程碑会用到。

### 6.3 类型检查：Node 不管类型，tsc 管

先做个实验。新建 `playground/type-error.ts`：

```ts
const count: number = "三";
console.log("count 是", count);
```

我们声明了 `count` 是 `number`（数字），却给了它一个字符串。运行它：

```bash
node playground/type-error.ts
```

```
count 是 三
```

居然没报错！原因是：**Node 运行 TypeScript 时只是把类型标注删掉，根本不检查类型对不对。** 删掉 `: number` 之后，这就是一段合法的 JavaScript。

那类型标注有什么用？答案是：交给 **TypeScript 编译器（tsc）** 去检查。安装它：

```bash
npm install --save-dev --save-exact typescript @types/node@24
```

- `typescript` 提供 `tsc` 命令。
- `@types/node` 告诉 TypeScript "Node.js 提供了哪些函数、它们的类型是什么"，比如 `process.cwd()` 返回 `string`。`@24` 表示安装第 24 版，它的大版本号最好和你的 Node 大版本一致（用 Node 22 就写 `@types/node@22`）。
- `--save-dev` 表示这是开发时才用的工具；`--save-exact` 表示记录精确的版本号（pi 项目也是这么做的，避免依赖悄悄升级带来意外）。

安装后会多出 `node_modules` 目录（第三方包都下载在这里）和 `package-lock.json`（记录每个包的确切版本）。

然后在 `my-pi` 目录新建 `tsconfig.json`，告诉 tsc 怎么检查：

```json
{
	"compilerOptions": {
		"target": "ES2024",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"lib": ["ES2024"],
		"types": ["node"],
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"verbatimModuleSyntax": true,
		"erasableSyntaxOnly": true,
		"skipLibCheck": true
	},
	"include": ["playground", "src", "test"]
}
```

每一项的意思（现在看不懂没关系，知道"这是配置"就行，后面用到时会再讲）：

| 配置 | 含义 |
| --- | --- |
| `target` / `lib` | 我们使用 2024 年标准的 JavaScript 语法和内置功能 |
| `module` / `moduleResolution` | 按 Node.js 的规则理解 `import` |
| `types: ["node"]` | 加载 Node.js 的类型信息 |
| `strict` | 开启严格检查。**一定要开**，它能帮你提前发现大量 bug |
| `noEmit` | 只检查，不生成任何文件（Node 能直接运行 `.ts`，不需要编译产物） |
| `allowImportingTsExtensions` | 允许写 `import ... from "./foo.ts"`（Node 要求写上扩展名） |
| `verbatimModuleSyntax` | 只导入类型时必须写 `import type`（下一章解释为什么） |
| `erasableSyntaxOnly` | 禁止使用"无法简单删除"的 TypeScript 语法，保证 Node 能直接运行 |
| `skipLibCheck` | 不检查第三方包内部的类型，加快速度 |
| `include` | 检查哪些目录 |

现在运行类型检查：

```bash
npx tsc
```

```
playground/type-error.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

读这条错误：`playground/type-error.ts` 文件，`(1,7)` 第 1 行第 7 列，错误编号 `TS2322`，内容是"string 类型不能赋值给 number 类型"。这正是我们故意犯的错。

> **记住这条规律**：`node 文件.ts` 负责**运行**，`npx tsc` 负责**检查**。写完代码，两个都要跑。养成习惯后，大部分低级错误在运行之前就会被 tsc 抓住。

删掉 `type-error.ts`（`rm playground/type-error.ts`），再运行 `npx tsc`，没有任何输出就代表检查通过。

为了方便，在 `package.json` 里加一个脚本：

```json
	"scripts": {
		"check": "tsc"
	},
```

以后运行 `npm run check` 就等于运行 `tsc`。

## 7. 用 git 给代码存档

**问题**：你改了一大堆代码，结果程序跑不起来了，而且想不起来改了哪里。

**解决**：git 是一个"存档"工具。每当代码处于一个能工作的状态，你就存一次档（commit）；改坏了，随时可以看到"和上次存档相比改了什么"，甚至回到上次存档。

第一次使用 git 需要告诉它你是谁：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

在 `my-pi` 目录里：

```bash
git init                 # 让 git 开始管理这个目录
```

新建 `.gitignore` 文件，写上不需要存档的东西：

```
node_modules/
.env
```

`node_modules` 可以随时用 `npm install` 重新下载，不需要存档；`.env` 以后会用来放 API key，**绝对不能**存进 git（更不能上传到网上）。

然后存第一次档：

```bash
git status               # 看看有哪些文件变化了
git add .                # 把所有变化放进"待存档区"
git commit -m "里程碑 00：项目初始化"
git log --oneline        # 查看存档历史
```

以后的日常用法就是：改代码 → `git status` / `git diff` 看看改了什么 → `git add` → `git commit -m "说明"`。

> 建议每完成一个里程碑，至少 commit 一次。

## 8. 读懂报错，学会找 bug

写代码 90% 的时间都在和错误打交道。不靠 AI 的程序员，最重要的能力之一就是**读报错**。

### 8.1 读一个真实的报错

新建 `playground/broken.ts`：

```ts
function makeGreeting(name: string): string {
	return `你好，${name}`;
}

const user = undefined as unknown as { name: string };

console.log(makeGreeting("小明"));
console.log(makeGreeting(user.name));
```

（`as unknown as ...` 是在故意欺骗类型检查器，让它以为 `user` 是个对象。现在不用理解，后面会讲。）

运行：

```bash
node playground/broken.ts
```

```
你好，小明
file:///home/me/my-pi/playground/broken.ts:8
console.log(makeGreeting(user.name));
                              ^

TypeError: Cannot read properties of undefined (reading 'name')
    at file:///home/me/my-pi/playground/broken.ts:8:31
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    ...
```

按这个顺序读：

1. **错误类型和消息**：`TypeError: Cannot read properties of undefined (reading 'name')`——"不能读取 undefined 的属性（正在读 name）"。也就是说，`.` 前面的东西是 `undefined`。
2. **位置**：`broken.ts:8:31`——第 8 行第 31 列。上面还贴心地打印了那一行代码，并用 `^` 指出了位置。
3. **调用栈（stack trace）**：`at ...` 开头的那些行，记录了"程序是怎么一步步走到这里的"。最上面一行是出错的地方，往下是调用它的地方。`node:internal` 开头的是 Node 自己的代码，通常可以忽略，只看你自己的文件。
4. 注意第一行输出 `你好，小明` 正常打印了：**出错之前的代码都执行了，出错之后的没执行**。这能帮你判断错误发生在哪个阶段。

### 8.2 console.log 大法

最朴素也最有效的调试方法：在怀疑的地方打印变量。

```ts
console.log("user 是：", user);
console.log(makeGreeting(user.name));
```

运行后你会看到 `user 是： undefined`，问题一目了然。

### 8.3 调试器

更强大的工具是**调试器**：它可以让程序在某一行停下来，让你查看每个变量的值，然后一行一行地往下执行。

在 VS Code 里：

1. 在行号左边点一下，出现一个红点，这叫**断点**。
2. 按 `Ctrl+Shift+P`（macOS 是 `Cmd+Shift+P`），输入 `JavaScript Debug Terminal`，回车，会打开一个特殊的终端。
3. 在这个终端里运行 `node playground/broken.ts`，程序会停在断点处。
4. 左侧面板能看到所有变量的值；用顶部的按钮"单步执行"。

前几个里程碑用 `console.log` 就够了，但当你写到 Agent Loop 时，调试器会成为你的好朋友。

## 9. 不靠 AI，去哪里查资料

这门课的目标是让你**不依赖 AI 写出 coding agent**。下面这些是程序员真正每天在用的资料，请收藏：

| 资料 | 用来查什么 |
| --- | --- |
| [现代 JavaScript 教程](https://zh.javascript.info/) | 中文，系统学习 JavaScript，强烈推荐配合本课阅读 |
| [MDN Web Docs](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript) | JavaScript 语法和内置函数的权威文档 |
| [Node.js 文档](https://nodejs.org/docs/latest/api/) | `fs`、`child_process`、`http` 等模块的用法 |
| [TypeScript 手册](https://www.typescriptlang.org/docs/handbook/intro.html) | 类型系统 |
| 各家大模型的 API 文档 | 请求和响应的格式（第 03 个里程碑起会用到） |
| 搜索引擎 | 把报错信息的关键部分（例如 `Cannot read properties of undefined`）粘贴进去搜索 |

查资料的技巧：

- 搜报错时，去掉你自己的文件名和路径，只保留通用部分。
- 优先看官方文档，其次看 Stack Overflow 上高票的回答。
- 读文档时看**例子**，例子往往比描述更好懂。

## 10. 运行与验证

完成本里程碑后，你的 `my-pi` 目录应该是这样：

```
my-pi/
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── node_modules/
└── playground/
    ├── hello.ts
    └── broken.ts
```

逐项检查：

- [ ] `node --version` 显示 22.18 或更高
- [ ] `node playground/hello.ts` 能打印问候语
- [ ] `npm run check` 没有任何输出（如果 `broken.ts` 还在，它不会报类型错误，因为我们用 `as` 骗过了检查器）
- [ ] `git log --oneline` 至少有一次提交

参考答案在 [code/](code/) 目录（它就是一个完成本里程碑后的 `my-pi`）。

## 11. 练习

1. **打印更多信息**：修改 `hello.ts`，再打印你的操作系统（`process.platform`）和当前时间（`new Date().toLocaleString("zh-CN")`）。
2. **命令行参数**：新建 `playground/greet.ts`，运行 `node playground/greet.ts 小明` 时打印 `你好，小明！`；不传参数时打印 `你好，陌生人！`。
   提示：`process.argv` 是一个数组，打印出来看看里面有什么。`??` 运算符可以提供默认值：`a ?? "默认"` 在 `a` 是 `undefined` 时得到 `"默认"`。
   参考答案：[code/playground/greet.ts](code/playground/greet.ts)
3. **制造错误**：故意写出下面三种错误，运行并读懂报错：
   - 调用一个不存在的函数：`hello();`
   - 拼错变量名：`console.log(nmae);`
   - 少写一个括号：`console.log("hi";`
   哪些错误 `tsc` 能提前发现？哪些只有运行时才会暴露？
4. **git 练习**：修改 `hello.ts`，用 `git diff` 查看改动，然后提交。再改坏它，用 `git restore playground/hello.ts` 恢复到上次提交的样子。

## 12. 自测问题

1. `node playground/hello.ts` 和 `npx tsc` 分别做了什么？为什么类型写错了 `node` 照样能运行？
2. 为什么 `.env` 和 `node_modules` 要写进 `.gitignore`？
3. 看到 `TypeError: Cannot read properties of undefined (reading 'x')`，你的第一反应应该是检查什么？
4. 相对路径 `playground/hello.ts` 是相对于什么的？

<details>
<summary>参考答案</summary>

1. `node` 删掉类型标注后执行代码；`tsc` 只检查类型、不执行。删掉类型后代码在 JavaScript 层面是合法的，所以能运行。
2. `.env` 里会放 API key 等秘密，泄露会被盗刷；`node_modules` 体积大，而且可以用 `npm install` 随时重建。
3. 检查 `.x` 前面那个东西为什么是 `undefined`。
4. 相对于当前工作目录（`pwd` 显示的目录），也就是 `process.cwd()`。

</details>

## 13. 对照 pi 源码

pi 本身就是一个 Node.js + TypeScript 项目，你可以在本仓库里看到同样的东西：

- [`package.json`](../../package.json)：`"type": "module"`，以及 `"engines": { "node": ">=22.19.0" }`——pi 也要求较新的 Node。
- [`tsconfig.base.json`](../../tsconfig.base.json)：里面有 `"strict": true`、`"erasableSyntaxOnly": true`、`"verbatimModuleSyntax": true`、`"allowImportingTsExtensions": true`，和我们的配置几乎一样。
- [`AGENTS.md`](../../AGENTS.md)：pi 项目给开发者（和 AI）的规则，其中有一条"Use only erasable TypeScript syntax (Node strip-only mode)"，说的正是 `erasableSyntaxOnly` 这件事。pi 的测试就是让 Node 直接运行 `.ts` 文件。
- [`.gitignore`](../../.gitignore)：同样忽略了 `node_modules/` 和 `.env`。

现在看不懂没关系。等你学完这门课再回来看，会发现每一行都认识。

## 14. 闭卷挑战

合上这份文档，在一个新目录里（比如 `~/practice-00`）从零完成：`npm init -y` → 加 `"type": "module"` → 安装 typescript → 写 `tsconfig.json`（允许偷看第 6.3 节的表格，但尽量凭记忆）→ 写一个打印当前时间的 `now.ts` → 运行并通过类型检查 → git 提交。

能在 15 分钟内完成，就可以进入下一个里程碑了。

---

下一步：[里程碑 01：TypeScript 最小必要知识](../01-typescript/README.md)
