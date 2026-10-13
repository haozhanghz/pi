# 里程碑 16：终端基础

> 目标：理解终端是怎样工作的——怎样控制颜色和光标、怎样一个键一个键地读取输入、怎样正确计算中文的显示宽度。这是下一章写全屏界面的地基。
>
> 完成后你将拥有：`src/tui/` 目录的第一批文件（`ansi.ts`、`width.ts`、`keys.ts`、`terminal.ts`），以及两个小程序：显示按键的 `playground/keys.ts`、原地刷新进度条的 `playground/progress.ts`。

```
$ node playground/keys.ts
按下任意键试试（方向键、Ctrl+字母、Alt+字母、粘贴一段文字……）。按 Ctrl+C 退出。

a            收到：a
up           收到：\x1b[A
你           收到：你
ctrl+right   收到：\x1b[1;5C
alt+enter    收到：\x1b\r
粘贴         23 个字符：第一行\r第二行
ctrl+c       收到：\x03
```

## 你将学到

- ANSI 转义序列：怎样让终端变色、移动光标、清除一行
- 原始模式：怎样一个键一个键地读取输入
- 按键的编码，以及为什么 Esc 键这么难处理
- 括号粘贴模式：区分"粘贴"和"打字"
- 显示宽度：为什么 `"你好".length` 不等于它在屏幕上占的宽度
- 怎样在原地重画几行，而不是不停地往下打印

---

## 1. 问题：一行一行地打印，屏幕会乱

我们现在的交互模式（`src/modes/repl.ts`）只会往下打印。模型的回答在流式输出，你在下面打字，两边的文字混在一起；bash 命令运行很久，想实时显示它的输出，却只能一行一行地往下追加；没有一个固定的输入框，没有状态栏……

pi 的界面是这样的：上面是对话记录，下面是一个固定的输入框，再下面是状态栏；正在运行的工具显示一个转圈的动画，命令的输出实时更新。要做到这些，我们需要能**控制终端**：把光标移回上面去、清掉一行、重新画。

这一章学习控制终端的基本功，下一章用它们搭一个界面框架。

## 2. ANSI 转义序列

### 2.1 终端的"暗号"

往终端输出一段以 ESC 字符（`\x1b`，ASCII 码 27）开头的特殊文字，终端不会把它显示出来，而是执行一个操作。试试：

```bash
node -e 'console.log("\x1b[31m红色\x1b[0m 正常 \x1b[1m粗体\x1b[0m")'
```

`\x1b[31m` 的意思是"把文字颜色设为红色"，`\x1b[0m` 是"恢复默认"。这些序列叫 **ANSI 转义序列**，几乎所有终端都支持。大部分序列以 `ESC [` 开头，这两个字符叫 **CSI**（Control Sequence Introducer）。

[code/src/tui/ansi.ts](code/src/tui/ansi.ts) 把常用的序列整理成了常量和函数：

```ts
const CSI = "\x1b[";

function style(open: number, close: number): (text: string) => string {
	return (text) => `${CSI}${open}m${text}${CSI}${close}m`;
}

export const bold = style(1, 22);
export const red = style(31, 39);
// ……

export const cursorUp = (n = 1) => (n > 0 ? `${CSI}${n}A` : "");
export const cursorToColumn = (column: number) => `${CSI}${column + 1}G`;
export const hideCursor = `${CSI}?25l`;
export const clearLine = `${CSI}2K`;
```

前几章 demo 里的 `dim`、`cyan`、`red` 就是这样写的。`style` 是一个**返回函数的函数**：`style(31, 39)` 返回一个"把文字包上红色"的函数。每种样式都有对应的"关闭"代码（红色是 39，表示"恢复默认的前景色"），这样嵌套使用时不会互相干扰：`bold(red("x"))` 关闭红色时不会把粗体也关掉。

最常用的几类：

| 序列 | 作用 |
| --- | --- |
| `\x1b[1m`、`\x1b[31m`……`\x1b[0m` | 样式和颜色（这类以 `m` 结尾的叫 SGR） |
| `\x1b[3A`、`\x1b[3B` | 光标上移、下移 3 行 |
| `\x1b[5G` | 光标移到第 5 列 |
| `\x1b[2K` | 清除光标所在的整行 |
| `\x1b[?25l`、`\x1b[?25h` | 隐藏、显示光标 |
| `\r` | 回到行首（这个不是转义序列，是一个普通的控制字符） |

### 2.2 同步输出

重画界面时，我们要输出一大串内容：移动光标、清除、写文字、再移动……终端可能在我们输出到一半的时候就把画面刷新出来，用户会看到闪烁。

**同步输出**（CSI 2026）解决这个问题：

```ts
export const SYNC_START = `${CSI}?2026h`;   // "先别显示"
export const SYNC_END = `${CSI}?2026l`;     // "现在一起显示"
```

把一次重画的所有内容包在中间，终端会等到 `SYNC_END` 再一次性更新画面。不支持的终端会忽略这两个序列，不会出问题。

### 2.3 原地刷新：progress.ts

[code/playground/progress.ts](code/playground/progress.ts) 同时显示三个进度条，在原地反复更新：

```ts
let previousLines = 0;
function draw(): void {
	const lines = render();
	// 光标回到上次画的第一行，逐行清除并重画。整个过程包在同步输出里，避免闪烁
	let output = SYNC_START + cursorUp(previousLines);
	for (const line of lines) output += `\r${clearLine}${line}\n`;
	output += SYNC_END;
	process.stdout.write(output);
	previousLines = lines.length;
}
```

思路很简单：记住上次画了几行，下次先把光标移上去这么多行，再一行一行地清除、重画。运行它：

```bash
node playground/progress.ts
```

这就是下一章"差量渲染"的雏形。下一章会更聪明：只重画**变了的**那几行。

注意 `render` 里的 `truncateToWidth`：如果窗口太窄，一行文字超出了宽度，终端会自动把它折成两行，我们记的"画了几行"就不对了，光标会移到错误的位置，画面就乱了。**每一行都不能超出终端的宽度**，这是终端界面的铁律。

## 3. 显示宽度

### 3.1 问题

```js
"hello".length   // 5，在终端里占 5 列
"你好".length    // 2，在终端里占 4 列！
"👨‍👩‍👧".length    // 8，在终端里占 2 列！
"\x1b[31m红\x1b[0m".length   // 10，在终端里占 2 列
```

- **汉字、日文假名、韩文、全角标点**是"宽字符"，每个占 2 列；
- **emoji** 也占 2 列，而且一个 emoji 可能由好几个码点组成（家庭 emoji 是"男人 + 连接符 + 女人 + 连接符 + 女孩"）；
- **控制序列**不占位置。

如果按 `.length` 截断和补齐，中文界面一定会错位。pi 的作者们为了中日韩文字的宽度问题修过很多 bug，这是做终端界面必须过的一关。

### 3.2 字形簇

"用户眼中的一个字符"叫**字形簇**（grapheme cluster）。JavaScript 内置的 `Intl.Segmenter` 能把文字切成字形簇：

```ts
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
[...segmenter.segment("é👨‍👩‍👧你")].map((s) => s.segment);
// ["é", "👨‍👩‍👧", "你"]：字母加声调符号是一个，家庭 emoji 是一个
```

### 3.3 每个字形簇占几列

[code/src/tui/width.ts](code/src/tui/width.ts)：

```ts
export function graphemeWidth(grapheme: string): number {
	const codePoint = grapheme.codePointAt(0) ?? 0;
	if (codePoint >= 0x20 && codePoint < 0x7f) return 1; // 最常见的情况：英文字母、数字、标点
	if (codePoint < 0x20 || codePoint === 0x7f) return 0; // 控制字符
	if (/\p{Emoji_Presentation}|️/u.test(grapheme)) return 2; // emoji
	if (/^\p{Mark}+$/u.test(grapheme)) return 0; // 单独的组合符号
	return isWide(codePoint) ? 2 : 1;
}
```

`isWide` 查一张码点范围的表：`0x4E00`~`0x9FFF` 是常用汉字，`0x3000`~`0x303E` 里有中文标点（。、「」），`0xFF00`~`0xFF60` 是全角字母和标点（，：？！）……Unicode 标准给每个字符规定了一个"东亚宽度"属性，我们的表只包含了最常用的部分。pi 用的是 `get-east-asian-width` 这个库，它包含完整的 Unicode 数据。

`\p{Emoji_Presentation}` 是正则表达式的 **Unicode 属性转义**（需要 `u` 标志），匹配"默认显示成 emoji 的字符"。`️` 是"请显示成 emoji"的变体选择符，比如 `❤️` 就是"红心 + FE0F"。

`visibleWidth` 先去掉所有控制序列，再把每个字形簇的宽度加起来：

```ts
export function visibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of segmenter.segment(text.replace(ANSI_PATTERN, ""))) width += graphemeWidth(segment);
	return width;
}
```

`ANSI_PATTERN` 是匹配控制序列的正则表达式，写在 `ansi.ts` 里，同时认识 CSI、OSC（终端超链接）、APC（下一章用来标记光标位置）三种序列。

### 3.4 截断和换行

有了 `visibleWidth`，就能正确地截断和换行。两者都要处理三个难点：按显示宽度计算、不把一个字（字形簇）切开、正确处理控制序列。

`truncateToWidth` 把文字拆成"控制序列"和"字形簇"两种 token，控制序列全部保留，字形簇加到放不下为止，最后加上省略号：

```ts
truncateToWidth("hello world", 8)   // "hello w…"
truncateToWidth("你好世界", 5)       // "你好…"：第三个字需要 2 列，只剩 1 列，放不下
```

带颜色的文字被截断后，末尾会多一个 `RESET`。否则如果截掉的部分里有"关闭红色"，红色就会"漏"到后面的内容里。

`wrapText` 自动换行，规则是：

- **英文单词不拆开**，在空格处换行；除非一个单词本身就比一行还宽，只能在中间拆开。
- **汉字可以在任意两个字之间换行**。中文没有空格分词，如果把一整句中文当成一个"单词"，它就只能在中间硬拆。
- **带颜色的文字**：如果一段红色的文字被拆成了两行，第一行末尾要关闭样式，第二行开头要重新打开红色。下一章的界面会逐行重画，每一行都必须是"独立"的，不能依赖上一行留下的样式。

```ts
wrapText("用 npm test 运行测试", 10)
// ["用 npm", "test 运行", "测试"]
```

实现的关键是先把文字分成"单元"：一个英文单词（连同中间的控制序列）、一段空格、一个汉字，然后贪心地往每一行里放，放不下就换行。代码见 `wrapLine`，配合 `test/width.test.ts` 里的例子读。

## 4. 读取按键

### 4.1 原始模式

平时终端是"行模式"：你打字时，终端自己显示你输入的字符，你可以用退格键修改，按下回车后，整行才交给程序。`readline` 就是在这个模式下工作的。

全屏界面需要**原始模式**（raw mode）：

```ts
process.stdin.setRawMode(true);
```

- 每按一个键，马上交给程序，不等回车；
- 终端不再自动显示你输入的字符（显示什么由程序决定）；
- **Ctrl+C 不再终止程序**，而是作为一个普通的按键（`\x03`）交给程序。所以程序必须自己处理 Ctrl+C，否则用户就退不出去了。

程序退出前一定要调用 `setRawMode(false)` 恢复，否则用户的终端会处在一个奇怪的状态（打字没有显示）。如果真遇到了这种情况，盲打 `reset` 再按回车可以恢复。

### 4.2 按键的编码

在原始模式下，不同的按键送来不同的文字：

| 按键 | 送来的内容 |
| --- | --- |
| 字母、数字、汉字 | 字符本身 |
| 回车 | `\r` |
| 退格 | `\x7f` |
| Tab | `\t` |
| Ctrl+A ~ Ctrl+Z | `\x01` ~ `\x1a`（字母在字母表里的位置） |
| Ctrl+J | `\n`（所以可以用它来"换行而不提交"） |
| Esc | `\x1b` |
| 方向键 上/下/右/左 | `\x1b[A`、`\x1b[B`、`\x1b[C`、`\x1b[D`（有的终端是 `\x1bOA` 等） |
| Ctrl+右方向键 | `\x1b[1;5C`：`1;5` 里的 5 表示修饰键（5 - 1 = 4 = Ctrl） |
| Alt+B | `\x1bb`：ESC 后面跟着这个字符 |
| Delete、Home、End、PageUp | `\x1b[3~`、`\x1b[H`（或 `\x1b[1~`）、`\x1b[F`（或 `\x1b[4~`）、`\x1b[5~` |

不同的终端对同一个键可能送来不同的序列（比如 Home 有四种写法），所以 [code/src/tui/keys.ts](code/src/tui/keys.ts) 的 `parseKey` 用一张表把它们都认下来。修饰键的编码是一个"位掩码"：值减 1 之后，第 1 位是 Shift，第 2 位是 Alt，第 3 位是 Ctrl：

```ts
const bits = Number(modified[1]) - 1;
return key(name, { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 });
```

`&` 是按位与：`bits & 4` 不为 0，说明第 3 位是 1。

`keyId` 把按键写成 `"ctrl+c"`、`"alt+enter"` 这样的名字，`matchesKey(data, "ctrl+c")` 用来判断按的是不是某个键。

还有一个细节：Shift+Enter 在大多数终端里和 Enter 送来的内容完全一样（都是 `\r`），程序根本分不出来。pi 通过一种叫 "kitty 键盘协议" 的扩展让支持它的终端发送更详细的按键信息。我们不实现它，所以"换行而不提交"用 Ctrl+J。

### 4.3 一次收到的数据，不一定是一个按键

`process.stdin` 的 `data` 事件每次给你一块数据，但这块数据：

- 可能包含**好几个**按键：打字很快时；用输入法一次输入好几个汉字时；
- 也可能只是一个按键的**一部分**：比如 `\x1b[A` 被拆成了 `\x1b[` 和 `A` 两块送来（网络很慢的 SSH 连接上经常发生）。

`KeyBuffer` 负责把数据切成完整的按键，不完整的部分留到下一次：

```ts
push(data: string): string[] {
	this.buffer += data;
	const keys: string[] = [];
	let start = 0;
	while (start < this.buffer.length) {
		const length = keyLength(this.buffer, start);
		if (length === 0) break;            // 后面的按键还不完整，等下一块数据
		keys.push(this.buffer.slice(start, start + length));
		start += length;
	}
	this.buffer = this.buffer.slice(start);
	return keys;
}
```

`keyLength` 判断从某个位置开始的按键有多长：普通字符就是一个字符（汉字、emoji 可能占两个 UTF-16 单元，所以用 `codePointAt`）；`ESC [` 开头的一直到结尾的字母；`ESC` 加一个字符是 Alt 组合键。

### 4.4 Esc 键的难题

单独收到一个 `\x1b`，它是什么？

- 可能是用户按了 **Esc 键**；
- 也可能是一个转义序列（比如方向键）的**开头**，后半段还在路上。

没法马上知道。唯一的办法是**等一等**：如果 50 毫秒内没有后续数据，就认为是 Esc 键。[code/src/tui/terminal.ts](code/src/tui/terminal.ts)：

```ts
private readonly handleData = (data: string) => {
	clearTimeout(this.flushTimer);
	for (const key of this.keys.push(data)) this.onKey(key);
	// 有不完整的数据（比如单独一个 ESC）：等一小会儿，没有后续就当作完整的按键
	if (this.keys.pending) {
		this.flushTimer = setTimeout(() => {
			for (const key of this.keys.flush()) this.onKey(key);
		}, ESCAPE_TIMEOUT_MS);
	}
};
```

这就是为什么在很多终端程序里（比如 vim），按下 Esc 键后会有一点点延迟。

### 4.5 括号粘贴

用户粘贴一段多行的文字。在原始模式下，粘贴的内容和打字没有区别：每个字符依次送来，里面的换行就是 `\r`——和回车键一模一样！如果不做处理，粘贴到第一个换行就会"提交"。

**括号粘贴模式**（bracketed paste）解决这个问题。程序输出 `\x1b[?2004h` 开启它之后，终端会把粘贴的内容包在 `\x1b[200~` 和 `\x1b[201~` 之间送来。`KeyBuffer` 把整段粘贴当作一个"按键"，`isPaste` 和 `pasteContent` 用来识别和取出内容。下一章的输入框会把粘贴的内容整体插入，里面的换行不会触发提交。

## 5. Terminal 接口

```ts
export interface Terminal {
	readonly columns: number;
	readonly rows: number;
	write(data: string): void;
	start(onKey: (key: string) => void, onResize: () => void): void;
	stop(): void;
}
```

`ProcessTerminal` 是真正的终端：`start` 开启原始模式和括号粘贴、隐藏光标、监听按键和窗口大小的变化；`stop` 把这些全部恢复。

为什么要定义一个接口？下一章的界面框架只和 `Terminal` 接口打交道。测试时，我们可以写一个"假终端"：它记录写入的内容，宽度和高度可以随意设置，按键可以由测试代码"按下"。不需要真的终端，也能测试界面——这又是一次依赖注入。

`handleData` 和 `handleResize` 写成了箭头函数的属性，而不是普通的方法。因为它们要作为事件监听器交给 `process.stdin.on`，普通方法被单独拿出去调用时，里面的 `this` 会丢失；箭头函数的 `this` 永远指向创建它的对象。`stop` 时用同一个函数 `off` 掉监听器。

## 6. 运行

**看看按键**：

```bash
node playground/keys.ts
```

试试方向键、Ctrl+字母、Alt+字母（macOS 的终端可能需要在设置里打开"把 Option 键当作 Meta 键"）、Esc、粘贴一段多行的文字、调整窗口大小。按 Ctrl+C 退出。

注意第一列的对齐：`你` 后面的空格比 `a` 后面少一个，因为 `你` 占 2 列。如果用 `padEnd` 补齐，汉字那一行就会对不齐——这个 demo 里就犯过这个错误，后来改成了按显示宽度补齐。

**原地刷新**：

```bash
node playground/progress.ts
```

运行的时候把窗口拉窄一点，看看 `truncateToWidth` 的作用；再把它删掉试试，看看超出宽度时画面会怎样乱掉。

## 7. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/tui/ansi.ts` | 样式（`bold`、`dim`、`red`、`green`……、`rgb`、`RESET`）、光标和屏幕（`cursorUp`、`cursorDown`、`cursorToColumn`、`hideCursor`、`showCursor`、`clearLine`、`clearScreen`）、`SYNC_START`/`SYNC_END`、括号粘贴的开关、`ANSI_PATTERN`、`stripAnsi` |
| `src/tui/width.ts` | `graphemeWidth`、`visibleWidth`、`truncateToWidth`、`wrapText` |
| `src/tui/keys.ts` | `Key`、`KeyBuffer`、`parseKey`、`keyId`、`matchesKey`、`isPaste`、`pasteContent`、`isPrintable`、`PASTE_START`/`PASTE_END` |
| `src/tui/terminal.ts` | `Terminal` 接口、`ProcessTerminal` |
| `src/tui/index.ts` | 导出以上所有内容 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `width.test.ts`（8 个测试）和 `keys.test.ts`（8 个测试），一共 249 个测试。终端相关的代码很难手动测试全面，这些测试覆盖了各种容易出错的情况：家庭 emoji、组合声调、全角标点、被拆开的转义序列、分几块送来的粘贴……

## 8. 常见错误

| 现象 | 原因 |
| --- | --- |
| 中文界面的边框、对齐全都错位 | 用 `.length` 或 `padEnd` 计算宽度 |
| 程序退出后，终端里打字不显示了 | 没有调用 `setRawMode(false)`。盲打 `reset` 回车可以恢复 |
| 按 Ctrl+C 退不出程序 | 原始模式下 Ctrl+C 只是一个普通的按键，要自己处理 |
| 按方向键时，偶尔出现 `[A` 这样的乱码 | 转义序列被拆成两块送来，没有拼起来 |
| 粘贴多行文字，粘贴到一半就提交了 | 没有开启括号粘贴模式 |
| 颜色"漏"到了下一行，或者截断之后后面的文字全变红了 | 换行或截断时，没有在末尾关闭样式 |
| 画面在原地刷新时越画越乱 | 某一行超出了终端的宽度，被终端自动折行了 |

## 9. 练习

1. **更多颜色**：给 `ansi.ts` 加上背景色函数（`bgRed`、`bgBlue`……，SGR 代码 41~47，关闭是 49），在 `progress.ts` 里用背景色画进度条。
2. **一个小游戏**：用原始模式和光标控制写一个"贪吃蛇"：方向键控制方向，`setInterval` 每 100 毫秒前进一步，用 `\x1b[行;列H`（把光标移到指定位置）画蛇和食物。（提示：`\x1b[2J` 清屏，`\x1b[?1049h` 和 `\x1b[?1049l` 切换到"备用屏幕"再切回来，退出时不会在终端里留下垃圾。）
3. **按键测试**：给 `test/keys.test.ts` 加上 Ctrl+Shift+方向键（`\x1b[1;6A`）、Alt+Shift+方向键的测试。
4. **宽度的边界情况**：`visibleWidth("⚠️")`、`visibleWidth("☺")`、`visibleWidth("Ａ")`（全角 A）分别是多少？在你的终端里实际占几列？不一致的话，改进 `graphemeWidth`。
5. **思考题**：为什么 Esc 键要等 50 毫秒？如果等 5 毫秒、等 500 毫秒，各有什么问题？

## 10. 自测问题

1. ANSI 转义序列是什么？`\x1b[31m` 和 `\x1b[2K` 分别做什么？
2. 同步输出解决了什么问题？
3. 原始模式和平时的模式有什么区别？使用原始模式时要注意什么？
4. 为什么一块数据不一定是一个按键？`KeyBuffer` 怎样处理？
5. 单独收到一个 `\x1b` 时为什么不能马上判断？怎么办？
6. 括号粘贴模式解决了什么问题？
7. `"你好".length` 是多少？在终端里占几列？为什么？
8. 带颜色的文字换行时要注意什么？

<details>
<summary>参考答案</summary>

1. 以 ESC 字符开头的特殊文字，终端不显示它，而是执行对应的操作。`\x1b[31m` 把文字颜色设为红色，`\x1b[2K` 清除光标所在的整行。
2. 一次重画要输出很多内容，终端可能在输出到一半时就刷新画面，造成闪烁。同步输出让终端等到结束标记再一次性更新。
3. 原始模式下每个按键马上交给程序，终端不自动显示输入，Ctrl+C 也不再终止程序。要自己处理 Ctrl+C，退出前要恢复终端的模式。
4. 打字快或者用输入法时，一块数据里有好几个按键；转义序列也可能被拆开分成几块送来。`KeyBuffer` 把完整的按键切出来，不完整的部分留到下一次。
5. 它可能是 Esc 键，也可能是转义序列的开头。等一小会儿（50 毫秒），没有后续数据就当作 Esc 键。
6. 原始模式下粘贴的换行和回车键送来的内容一样，会被误当成提交。开启括号粘贴后，粘贴的内容被特殊标记包起来，程序可以整体处理。
7. 2；占 4 列。汉字是东亚宽字符，每个占 2 列，`.length` 数的是 UTF-16 单元的个数。
8. 每一行末尾要关闭样式，下一行开头重新打开，让每一行都是独立的。

</details>

## 11. 对照 pi 源码

pi 的终端界面是一个独立的包 [packages/tui](../../packages/tui/)。

- **[terminal.ts](../../packages/tui/src/terminal.ts)**：`ProcessTerminal` 开启原始模式、括号粘贴（`\x1b[?2004h`）。它还会尝试开启 kitty 键盘协议（`KITTY_KEYBOARD_PROTOCOL_QUERY`），让支持的终端区分 Shift+Enter 和 Enter 这类按键；不支持的终端退而使用 xterm 的 "modifyOtherKeys"（`\x1b[>4;2m`）。
- **[stdin-buffer.ts](../../packages/tui/src/stdin-buffer.ts)**：对应我们的 `KeyBuffer`，把输入切成完整的按键，处理被拆开的转义序列和括号粘贴，用超时处理单独的 ESC。
- **[keys.ts](../../packages/tui/src/keys.ts)**：一千多行，`matchesKey` 支持传统的转义序列、kitty 协议、modifyOtherKeys 等各种编码。
- **[utils.ts](../../packages/tui/src/utils.ts)**：`visibleWidth`（用 `Intl.Segmenter` 切字形簇，用 `get-east-asian-width` 判断宽字符，还有一个缓存）、`truncateToWidth`、`wrapTextWithAnsi`（换行时用 `AnsiCodeTracker` 记住哪些样式还开着）。读 `graphemeWidth` 函数，你会看到为了处理各国文字的显示宽度，有多少边界情况：泰文、印度文字的组合符号，国旗 emoji……
- **[keybindings.ts](../../packages/tui/src/keybindings.ts)**：所有按键都可以重新配置。`"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"] }`——和我们一样，Ctrl+J 是换行的后备方案。

## 12. 闭卷挑战

不看资料，写出：

1. `visibleWidth` 和 `truncateToWidth`（不用处理控制序列的版本也可以）；
2. `KeyBuffer.push`；
3. `parseKey` 的主要部分：回车、退格、方向键、Ctrl+字母、Alt+字符。

让 `test/width.test.ts` 和 `test/keys.test.ts` 的大部分测试通过。

---

上一步：[里程碑 15：上下文压缩](../15-compaction/README.md) · 下一步：[里程碑 17：组件与差分渲染](../17-tui/README.md)
