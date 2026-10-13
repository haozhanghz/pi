# 里程碑 18：输入框与 Markdown

> 目标：做出 mini-pi 真正要用的两个组件——一个多行编辑器（用户在这里输入），一个 Markdown 渲染器（用来显示模型的回答）。顺便把快捷键整理成一张可以修改的表。
>
> 完成后你将拥有：`src/tui/keybindings.ts`、`src/tui/components/editor.ts`、`src/tui/components/markdown.ts`，以及演示程序 `playground/markdown-demo.ts`。

```
$ node playground/markdown-demo.ts

 Markdown 预览

 预览：
 修复步骤

 1. 打开 src/utils.ts
 2. 运行测试
    ┌──────┬──────────┐
    │ 命令 │ 说明     │
    ├──────┼──────────┤
    │ test │ 运行测试 │
    └──────┴──────────┘

────────────────────────────────────────────────────────────
 ## 修复步骤
 1. 打开 `src/utils.ts`
 2. 运行测试
    | 命令 | 说明 |
    |---|---|
    | test | 运行测试 |█
────────────────────────────────────────────────────────────
 回车发送 · Alt+Enter 或 Ctrl+J 换行 · ↑ 翻看历史 · Ctrl+C 退出
```

## 你将学到

- 快捷键表：把"按了哪个键"和"要做什么"分开
- 多行编辑器的数据结构：逻辑行、光标、屏幕行
- 自动折行之后，怎样知道光标在哪一行哪一列
- 上下移动时的"记忆列"
- 按词移动和删除：`Intl.Segmenter` 的分词模式（中文也能分词）
- 输入历史
- 写一个小小的 Markdown 解析器：先分块，再处理行内格式
- 流式输出给 Markdown 渲染带来的特殊情况
- 新的用法暴露出旧代码的问题：修复 `wrapText`

---

## 1. 问题

上一章的 `Input` 只能输入一行。可是给 coding agent 的指令经常有好几行：贴一段报错、贴一段代码、列出几个要求。我们需要一个**多行编辑器**：能换行、能自动折行、能用方向键在行之间移动、能找回之前发过的内容。

另一边，模型的回答几乎都是 Markdown。直接显示是这样的：

```
## 修复步骤
1. 打开 `src/utils.ts`，把 **第 12 行** 改成：
   ```ts
   const month = date.getMonth() + 1;
   ```
```

到处是 `##`、`**`、反引号，很难读。我们需要一个 **Markdown 渲染器**：标题变成彩色粗体、代码块缩进并换个颜色、表格画上边框……

## 2. 快捷键表

### 2.1 问题：按键写死在代码里

上一章的 `Input` 用一个 `switch` 判断按键：

```ts
switch (keyId(parseKey(data))) {
	case "left":
	case "ctrl+b":
		this.cursor = this.previousBoundary();
		return;
	// ……
}
```

编辑器要支持二十多个快捷键。每个人的习惯不一样：有人想用 Ctrl+S 提交，有的终端里 Alt+B 用不了。按键散落在各个组件的代码里，想换一个键就得改代码。

### 2.2 解决办法：动作和按键分开

给每个操作起一个名字，叫**动作**（action），再用一张表记录每个动作对应哪些按键：

```ts
export const DEFAULT_KEYBINDINGS = {
	"editor.cursorUp": ["up"],
	"editor.cursorLeft": ["left", "ctrl+b"],
	"editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
	"editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
	"input.submit": ["enter"],
	// 大多数终端分不清 Shift+Enter 和 Enter，所以换行用 Alt+Enter 或 Ctrl+J
	"input.newLine": ["alt+enter", "ctrl+j"],
	// ……
} satisfies Record<string, string[]>;

/** 所有动作的名字："editor.cursorUp" | "editor.cursorLeft" | …… */
export type KeyAction = keyof typeof DEFAULT_KEYBINDINGS;
```

组件只问"这个按键是不是触发了某个动作"：

```ts
export function matchesAction(data: string, action: KeyAction): boolean {
	return keybindings[action].includes(keyId(parseKey(data)));
}
```

`Input` 改成这样：

```ts
if (matchesAction(data, "input.submit")) {
	this.onSubmit?.(this.value);
} else if (matchesAction(data, "editor.cursorLeft")) {
	this.cursor = this.previousBoundary();
} // ……
```

用户想换键位，调用 `setKeybindings({ "input.submit": ["ctrl+s"] })` 就行，所有组件自动生效。里程碑 20 会从设置文件里读取用户的配置。

两个 TypeScript 的小知识：

- **`keyof typeof`**：`typeof DEFAULT_KEYBINDINGS` 取出这个对象的类型，`keyof` 再取出它所有键名组成的联合类型。写错动作的名字（比如 `"editor.curserLeft"`），类型检查马上报错。
- **`satisfies`**：检查这个对象符合 `Record<string, string[]>`，但**不改变**它自己的类型。如果写成 `const DEFAULT_KEYBINDINGS: Record<string, string[]> = {...}`，它的键就变成了任意字符串，`keyof` 也就只能得到 `string`，类型检查就帮不上忙了。

用户写的按键名可能是 `"Shift+Ctrl+Up"`，而 `keyId` 产生的是 `"ctrl+shift+up"`。`normalizeKeyId` 把它们统一成同一种写法：修饰键按 ctrl、alt、shift 的顺序排列，全部小写。

> **为什么不用 Shift+Enter 换行？** 在大多数终端里，Enter 和 Shift+Enter 送来的都是 `\r`，程序根本分不出来（上一章的按键编码表里没有 Shift+Enter）。pi 会尝试开启 kitty 键盘协议来区分它们；我们用 Alt+Enter 和 Ctrl+J，另外学 pi 提供一个后备办法：**在行尾输入 `\` 再按回车**，就是换行。

## 3. 多行编辑器

### 3.1 数据结构

编辑器的内容存成一个**行的数组**，加上光标的位置：

```ts
private lines: string[] = [""];
private cursorLine = 0; // 光标在第几行
private cursorCol = 0;  // 光标在这一行的哪个位置（字符串下标）
```

比如输入了 `你好`、按 Ctrl+J、再输入 `world`：

```
lines      = ["你好", "world"]
cursorLine = 1
cursorCol  = 5
```

这里的"行"是用户按换行键分开的行，叫**逻辑行**。和上一章的 `Input` 一样，`cursorCol` 总是落在两个字形簇之间。

所有的编辑操作，都是在修改这个数组。**插入**一段文字（可能包含换行）：

```ts
private insertText(text: string): void {
	// 统一换行符，制表符换成空格，去掉其他控制字符
	const clean = text
		.replace(/\r\n?/g, "\n")
		.replaceAll("\t", "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
	if (clean === "") return;
	const inserted = clean.split("\n");
	const last = inserted.length - 1;
	const after = this.currentLine.slice(this.cursorCol);
	inserted[0] = this.currentLine.slice(0, this.cursorCol) + inserted[0];
	this.cursorCol = inserted[last].length;
	inserted[last] += after;
	this.lines.splice(this.cursorLine, 1, ...inserted);
	this.cursorLine += last;
	this.changed();
}
```

举个例子：当前行是 `XY`，光标在 X 后面（`cursorCol = 1`），插入 `"a\nb"`：

```
inserted = ["a", "b"]
inserted[0] = "X" + "a"      → ["Xa", "b"]
cursorCol = "b".length = 1
inserted[1] += "Y"           → ["Xa", "bY"]
用 ["Xa", "bY"] 替换原来的 "XY"，光标下移一行
```

打字、换行（插入 `"\n"`）、粘贴都用它。

**删除**分两种：删光标前面的（退格、Ctrl+W、Ctrl+U），删光标后面的（Delete、Ctrl+K）。共同的特殊情况是：光标在行首时退格，要把这一行**接到上一行后面**；光标在行尾时 Delete，要把下一行接上来。

```ts
/** 删除光标前面、从 start 开始的内容。光标在行首时，和上一行合并 */
private deleteBefore(start: number): void {
	if (this.cursorCol === 0) {
		if (this.cursorLine === 0) return;
		const previous = this.lines[this.cursorLine - 1];
		this.lines.splice(this.cursorLine - 1, 2, previous + this.currentLine);
		this.cursorLine--;
		this.cursorCol = previous.length;
	} else {
		this.lines[this.cursorLine] = this.currentLine.slice(0, start) + this.currentLine.slice(this.cursorCol);
		this.cursorCol = start;
	}
	this.changed();
}
```

退格是 `deleteBefore(上一个字形簇的开头)`，Ctrl+W 是 `deleteBefore(上一个词的开头)`，Ctrl+U 是 `deleteBefore(0)`。一个函数，三种用法。

### 3.2 折行和屏幕行

一个逻辑行可能比输入框宽，要折成好几行显示。折出来的每一行叫**屏幕行**，记录它属于哪个逻辑行、从哪里到哪里：

```ts
interface VisualLine {
	line: number;  // 属于第几个逻辑行
	start: number; // 在这个逻辑行里的起止位置
	end: number;
}
```

比如宽度是 10，逻辑行 `aaaa bbbb cccc` 折成两个屏幕行：

```
{ line: 0, start: 0,  end: 10 }   "aaaa bbbb "
{ line: 0, start: 10, end: 14 }   "cccc"
```

为什么要记位置，而不是像 `wrapText` 那样直接返回折好的文字？因为**光标**需要它：画光标要知道它在哪个屏幕行的第几列；按上下方向键是在屏幕行之间移动，而不是在逻辑行之间。

`wrapPositions` 的算法和 `wrapText` 差不多：一个字一个字地累加宽度，记住最近一个可以折行的位置（空格后面、汉字后面），超出宽度时就在那里折行。有一处不同：**空格不会引起折行**，它可以"挂"在行尾。为什么？假设宽度是 5，文字是 `hello world`：`hello` 正好占满一行，后面的空格如果也引起折行，就会多出一个只有一个空格的屏幕行。让空格挂在行尾，结果就是 `"hello "` 和 `"world"`。挂出去的空格超出宽度的部分，渲染时用 `truncateToWidth(text, width, "")` 截掉（省略号传空字符串）。

**光标在哪个屏幕行**：光标在 `start` 和 `end` 之间就在这一行。边界上有一个规则：光标正好在折行处（比如上面例子里的位置 10）时，算作**下一行的开头**；只有一个逻辑行的最后一段，光标才能停在末尾。

```ts
private cursorRow(visual: VisualLine[]): number {
	const row = visual.findIndex((visualLine, index) => {
		if (visualLine.line !== this.cursorLine) return false;
		const isLastOfLine = index === visual.length - 1 || visual[index + 1].line !== visualLine.line;
		return (
			this.cursorCol >= visualLine.start &&
			(this.cursorCol < visualLine.end || (isLastOfLine && this.cursorCol === visualLine.end))
		);
	});
	return Math.max(0, row);
}
```

### 3.3 上下移动和"记忆列"

按上方向键：找到光标所在的屏幕行，算出光标在这一行的**显示列**（从行首到光标的显示宽度），再到上一个屏幕行里找到同一列的位置。注意是按显示宽度找，因为汉字占两列。

有一个细节会影响手感。假设有三行，光标在第一行的第 10 列：

```
long line here      ← 光标在第 10 列
ab
long line again
```

按下方向键，第二行只有 2 列，光标停在行尾（第 2 列）。再按下方向键，光标应该回到第 10 列，而不是停在第 2 列。所以编辑器要记住"想去的列"（`preferredColumn`）：上下移动时使用并保留它，按了别的键就清掉。

```ts
private moveToRow(visual: VisualLine[], from: number, to: number): void {
	const source = visual[from];
	const target = visual[to];
	const column = this.preferredColumn ?? visibleWidth(this.lines[source.line].slice(source.start, this.cursorCol));
	this.preferredColumn = column;
	// ……在 target 里往右走，直到再走一个字就超过 column
}
```

上下移动依赖折行的宽度，可宽度只有渲染时才知道。所以 `render` 把排版宽度记在 `layoutWidth` 里，移动光标时用同样的宽度重新排一遍。

### 3.4 按词移动：让浏览器引擎帮我们分词

Alt+B / Alt+F 按词移动，Ctrl+W 删除前一个词。英文的词好办，空格分开；中文呢？"你好世界"是一个词还是四个字？

`Intl.Segmenter` 除了上一章用过的字形簇模式，还有**分词模式**，而且自带词典，能给中文分词：

```ts
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
[...wordSegmenter.segment("hello world, 你好世界")].map((s) => [s.segment, s.isWordLike]);
// [["hello", true], [" ", false], ["world", true], [",", false], [" ", false], ["你好", true], ["世界", true]]
```

`isWordLike` 告诉我们这一段是不是"词"（空格和标点不是）。"光标左边一个词的开头"就是：从光标往左，先跳过空白，再跳过一个词；如果碰到的是标点，就跳过连续的一串标点。

```ts
function wordStartBefore(text: string, index: number): number {
	const segments = [...wordSegmenter.segment(text.slice(0, index))];
	let i = segments.length - 1;
	while (i >= 0 && segments[i].segment.trim() === "") i--;
	if (i < 0) return 0;
	if (!segments[i].isWordLike) {
		while (i > 0 && !segments[i - 1].isWordLike && segments[i - 1].segment.trim() !== "") i--;
	}
	return segments[i].index;
}
```

在 `hello world, 你好世界` 的末尾按 Ctrl+W，删掉的是"世界"，而不是一个字或者一整句。

### 3.5 输入历史

用户提交过的内容存在 `history` 里，最新的在最前面。`historyIndex` 表示正在看第几条，-1 表示没有在翻看。

- 光标在**第一个屏幕行**时按上方向键：看更早的一条。开始翻看之前，先把输入框里正在写的内容存到 `draft`。
- 光标在**最后一个屏幕行**、正在翻看时按下方向键：看更新的一条；翻到头就恢复 `draft`。
- 翻看时开始打字：退出翻看状态，当前显示的内容就成了新的草稿。

还有两个和 pi 一样的小设计：

- 输入框里有内容、光标又不在行首时，第一次按上方向键只把光标移到行首，第二次才翻看历史。免得用户只是想移动光标，却把正在写的内容换掉了。
- 往上翻时光标放在**开头**，往下翻时放在**末尾**。这样即使某条历史有好几行，连续按同一个方向键也能一直翻下去。

### 3.6 渲染

```ts
render(width: number): string[] {
	// 左边空一列；右边留一列，光标在行尾时画在那里
	const contentWidth = Math.max(1, width - 2);
	this.layoutWidth = contentWidth;
	const visual = this.layout(contentWidth);
	const row = this.cursorRow(visual);

	// 上下滚动，让光标所在的行始终看得见
	if (row < this.scroll) this.scroll = row;
	if (row >= this.scroll + this.maxHeight) this.scroll = row - this.maxHeight + 1;
	this.scroll = Math.min(this.scroll, Math.max(0, visual.length - this.maxHeight));
	const shown = visual.slice(this.scroll, this.scroll + this.maxHeight);
	// ……上面一条横线；每个屏幕行（光标所在的行画上假光标和光标标记）；下面一条横线
}
```

- 为什么右边要留一列？光标在行尾时，要在文字后面画一个反色的空格。不留这一列，正好写满一行的文字加上光标就超出宽度了。
- 粘贴一大段文字，输入框不能无限变高，否则把对话全挤到屏幕外面去了。最多显示 `maxHeight` 行，多出来的上下滚动，横线上显示 `↑ 还有 2 行`。

### 3.7 提交

按回车：把内容去掉首尾空白，交给 `onSubmit`，清空输入框。存不存进历史由使用者决定（调用 `addToHistory`）——比如以后的斜杠命令可能不想存。

## 4. Markdown 渲染

### 4.1 两步走：先分块，再处理行内格式

Markdown 的格式分两层：

- **块**：一段一段的结构。标题、段落、代码块、列表、引用、表格、分隔线。块由**行**决定：`#` 开头是标题，` ``` ` 开始一个代码块，`- ` 开头是列表项……
- **行内格式**：一段文字里面的格式。粗体、斜体、行内代码、链接……

所以渲染分三步：

1. `parseBlocks`：一行一行地扫描，把文字切成块；
2. `renderInline`：处理每一块里的行内格式；
3. `renderBlock`：把每一块画成不超过宽度的行。

真正的 Markdown 解析器（pi 用的 marked）也是这样分层的。

### 4.2 分块

```ts
type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "code"; language: string; lines: string[] }
	| { type: "quote"; blocks: Block[] }
	| { type: "list"; items: { marker: string; blocks: Block[] }[] }
	| { type: "table"; rows: string[][] }
	| { type: "rule" };
```

`parseBlocks` 是一个循环，每次看当前这一行，判断它开始的是哪一种块，把属于这个块的行都吃掉，然后继续。判断的**顺序**有讲究：

1. **代码块最先**：` ``` ` 和结束标记之间的内容原样保留，里面的 `#`、`-` 都不算数。
2. **标题**：`#` 到 `######` 加一个空格。
3. **分隔线在列表之前**：`* * *` 既像分隔线，又像以 `*` 开头的列表项，它是分隔线。
4. **引用**：连续的 `>` 开头的行，去掉 `> ` 之后**递归**调用 `parseBlocks`——引用里还可以有列表、代码块。
5. **列表**（见下面）。
6. **表格**：这一行有 `|`，下一行是 `|---|---|` 这样的分隔行。表格可以紧跟在一行文字后面，不需要空行——模型经常写"对比如下："然后马上开始一个表格。
7. 都不是，就是**段落**：一直到空行、或者另一种块的开头为止。段落里的换行保留下来（终端里按原样换行，更符合模型的本意）。

**列表**最复杂，因为可以嵌套：

```
- 苹果
  - 红富士
- 香蕉
```

处理一个列表项时，先拿到它的第一行（`苹果`），然后把后面**缩进更深的行**都算作这一项的内容，去掉缩进：`- 红富士`。这一项的内容再**递归**交给 `parseBlocks`，里面的 `- 红富士` 自然就成了一个嵌套的列表。列表项里的代码块、多个段落，都是这样处理的。递归让复杂的嵌套结构变得很简单。

### 4.3 行内格式：最靠前的匹配优先

每种行内格式用一个正则表达式描述：

```ts
const INLINE_RULES: InlineRule[] = [
	{ pattern: /\\([\\`*_{}[\]()#+\-.!|~>])/, render: (match) => match[1] }, // 转义：\* 显示成 *
	{ pattern: /`([^`\n]+)`/, render: (match) => STYLE.code(match[1]) },      // 行内代码
	{ pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/, render: (match) => bold(renderInline(match[1] ?? match[2])) },
	// ……斜体、删除线、链接
];
```

`renderInline` 每一轮拿所有规则去匹配剩下的文字，选**位置最靠前**的那个匹配；把它前面的普通文字和它渲染的结果接起来，再处理剩下的部分：

```ts
function renderInline(text: string): string {
	let result = "";
	let rest = text;
	while (rest !== "") {
		let best: { match: RegExpExecArray; rule: InlineRule } | undefined;
		for (const rule of INLINE_RULES) {
			const match = rule.pattern.exec(rest);
			if (match && (best === undefined || match.index < best.match.index)) best = { match, rule };
		}
		if (best === undefined) return result + rest;
		result += rest.slice(0, best.match.index) + best.rule.render(best.match);
		rest = rest.slice(best.match.index + best.match[0].length);
	}
	return result;
}
```

以 `**运行 `npm test`**` 为例：第一轮，粗体规则在位置 0 匹配，比行内代码规则（位置 5）靠前，选粗体。粗体的 `render` 对里面的 `运行 `npm test`` **递归**调用 `renderInline`，这一次行内代码规则匹配了。结果是粗体里面套着黄色的代码。

为什么行内代码最先、而且不递归？代码里的 `*` 和 `_` 是代码的一部分，不是格式。同一位置有多个规则匹配时，排在前面的规则优先。

两个细节：

- 斜体的下划线版本要求前后不是字母或数字（`(?<![\p{L}\p{N}_])`，这叫**后行断言**），这样 `snake_case_name` 不会被当成斜体。
- 局限：`*斜体里面有 **粗体***` 这种复杂的嵌套处理不了。完整的规则（CommonMark 规范）非常复杂，对模型的回答来说，这些就够用了。

### 4.4 把块画成行

每一种块知道自己怎么折行：

| 块 | 怎么画 |
| --- | --- |
| 标题 | 粗体青色；一级标题加下划线；三级以下保留 `###`，好和二级标题区分 |
| 段落 | 处理行内格式，`wrapText` 折行 |
| 代码块 | 上下一行灰色的 ` ``` `；每行缩进 2 列，绿色；太长的行按 `width - 2` 折行 |
| 引用 | 里面的块按 `width - 2` 画好，每一行前面加 `│ ` |
| 列表 | 每一项的内容按"宽度减去编号的宽度"画好；第一行前面加编号，后面的行用同样宽的空格对齐 |
| 表格 | 见下面 |
| 分隔线 | 一条灰色的横线 |

列表项的内容要用**更窄的宽度**来画，这样折行之后，第二行和第一行的文字对齐：

```
- 一个很长很长很
  长的列表项        ← 和"一"对齐，而不是顶格
```

**表格**：每一列和这一列最宽的单元格一样宽。整个表格比屏幕宽的时候，把最宽的那一列减一，再看放不放得下，直到放下为止；单元格里的文字按列宽折行，一行表格可能占好几行屏幕。

最后 `renderMarkdown` 还会把每一行再用 `truncateToWidth` 截一次——窗口非常窄的时候，缩进本身可能就超过了宽度。宽度契约不能有任何例外。

### 4.5 流式输出带来的特殊情况

模型的回答是一个字一个字到来的，Markdown 组件每收到一块就重新解析、渲染一遍全部内容（有缓存，解析也很快）。这带来几个特殊情况：

- **代码块还没结束**：只有开头的 ` ``` `，没有结束标记。那就一直算到最后一行，照样画成代码块。
- **结束标记只来了一半**：最后一行是 ` `` `。如果把它当作代码显示，下一个 `` ` `` 到来时它就变成了结束标记，代码块突然少一行，画面跳一下。所以代码块还没结束时，末尾的空行和"半个结束标记"先不显示（pi 也是这样做的，见 [issue #5825](https://github.com/earendil-works/pi/issues/5825)）。
- **粗体还没结束**：`**粗` 匹配不上粗体规则，先原样显示星号，等 `**` 来了再变成粗体。

### 4.6 新的用法暴露出旧代码的问题

用 Markdown 渲染这门课的 README 时，发现了 `wrapText`（里程碑 16）的两个问题。

**问题一：样式跨越换行符就丢了。** 段落里的粗体可能跨过一个换行：`**第一行\n第二行**`。`wrapText` 先按 `\n` 切成两段，每段**从头开始**记录样式，第二段不知道粗体还开着，于是第二行不是粗体。

**问题二：样式越积越多。** 原来的实现把遇到的每一个样式代码都存进数组，包括关闭的代码。一段有几十处行内代码的段落，每次折行都要在下一行开头重新输出几十个代码。

解决办法是一个 `StyleTracker`：把样式**分类**（粗细、斜体、下划线、前景色、背景色……），每一类只记最后一个；遇到关闭代码（比如 `\x1b[39m` 关闭前景色）就删掉这一类；遇到 RESET 全部清空。`wrapText` 用同一个 `StyleTracker` 处理所有的段落，样式就能跨越换行符了：

```
wrapText(`${red("红")}${green("绿")}${red("很长很长的红色文字")}`, 6)
原来：第二行开头是 \x1b[31m\x1b[39m\x1b[32m\x1b[39m\x1b[31m长……
现在：第二行开头是 \x1b[31m长……
```

`test/width.test.ts` 新增了两个测试，正好描述这两个问题。这是很常见的经历：代码写好的时候测试全过，等到有了新的用法，才发现之前没想到的情况。发现问题时，**先写一个会失败的测试，再修代码**。

## 5. 运行

```bash
node playground/markdown-demo.ts
```

输入框里预先放了一段 Markdown，上面实时显示渲染的效果。试试这些：

1. 输入标题、列表、表格、代码块，看预览的变化。用 Ctrl+J 或 Alt+Enter 换行，或者在行尾输入 `\` 再按回车。
2. 按回车发送，上面多了一条消息；按上方向键找回刚才发送的内容。
3. 输入一行很长的文字，用上下方向键在折行之间移动；输入中英文混合的句子，试试 Ctrl+W 和 Alt+B。
4. 粘贴一段十几行的代码：输入框最多显示 8 行，横线上显示还有几行被隐藏了。

还可以直接渲染一个 Markdown 文件，比如这门课的 README（在 `code/` 目录下运行）：

```bash
node playground/markdown-demo.ts ../../README.md
```

## 6. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/tui/keybindings.ts` | `DEFAULT_KEYBINDINGS`、`KeyAction`、`normalizeKeyId`、`setKeybindings`、`getKeys`、`matchesAction` |
| `src/tui/components/editor.ts` | `Editor({ maxHeight })`：`focused`、`onSubmit`、`onChange`、`getText`、`setText`、`getCursor`、`addToHistory` |
| `src/tui/components/markdown.ts` | `renderMarkdown(text, width)`、`Markdown(text, paddingX = 1)`：`getText`、`setText` |
| `src/tui/components/input.ts` | 改用 `matchesAction` |
| `src/tui/width.ts` | `wrapText` 改用 `StyleTracker`：样式可以跨越换行符，不会越积越多 |
| `src/tui/ansi.ts` | 新增 `strikethrough` |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `keybindings.test.ts`（3 个测试）、`editor.test.ts`（13 个测试）、`markdown.test.ts`（13 个测试），`width.test.ts` 新增 2 个，一共 306 个测试。

## 7. 常见错误

| 现象 | 原因 |
| --- | --- |
| 退格把一个 emoji 删成了乱码 | 按字符串下标删了一个 UTF-16 单元，而不是一个字形簇 |
| 在行首按退格没反应 | 没有处理"和上一行合并" |
| 按上方向键，光标跳到了奇怪的位置 | 用字符串下标而不是显示宽度来对齐列；或者移动时用的折行宽度和渲染时不一样 |
| 光标在折行处显示在上一行的末尾，超出了宽度 | 折行处的光标要算作下一行的开头 |
| 粘贴的代码前面多了奇怪的符号，或者缩进乱了 | 没有统一 `\r\n`、没有把制表符换成空格 |
| `snake_case_name` 中间变成了斜体 | 下划线斜体没有检查前后是不是字母 |
| 代码块里的 `**` 被当成了粗体 | 先处理了行内格式，再识别代码块；顺序反了 |
| 窗口很窄时程序报"超过了终端的宽度" | 某种块（列表缩进、表格）没有处理极端的宽度 |
| 回答流式输出时，代码块的末尾一跳一跳的 | 半个结束标记被当成代码显示了 |

## 8. 练习

1. **撤销**：加一个 `editor.undo` 动作（Ctrl+-）。每次修改之前把 `{ lines, cursorLine, cursorCol }` 存进一个栈，撤销时弹出来。进阶：连续输入的字合并成一次撤销（pi 的做法：一个词算一次）。
2. **剪切环**：Ctrl+K、Ctrl+U、Ctrl+W 删除的内容存起来，Ctrl+Y 粘贴回来（Emacs 和 shell 都有这个功能）。
3. **大段粘贴**：粘贴超过 10 行时，输入框里只显示 `[粘贴 #1，共 120 行]`，提交时再换回原来的内容。光标移动、删除时，要把这个标记当成一个整体。
4. **避头尾**：中文排版不允许行首出现"，。：）"这类标点。改进 `wrapText`：遇到这类标点时，把它和前一个字一起放到下一行（或者允许它挂在上一行末尾）。
5. **表格对齐**：支持 `:---:`（居中）和 `---:`（靠右）。
6. **代码高亮**：给 TypeScript 代码块里的关键字（`const`、`function`、`return`……）换个颜色。用正则表达式就行，注意不要把字符串里的关键字也染上色。
7. **思考题**：为什么 Markdown 要先按行分块，而不是用一个大的正则表达式一次处理整段文字？

## 9. 自测问题

1. 快捷键表解决了什么问题？`satisfies` 在这里起什么作用？
2. 为什么大多数终端里不能用 Shift+Enter 换行？mini-pi 提供了哪些替代办法？
3. 编辑器怎样存储内容和光标？在行首按退格时发生了什么？
4. 什么是屏幕行？为什么要记录它在逻辑行里的起止位置，而不是只保存折好的文字？
5. 光标正好在折行处时，算在哪一行？为什么？
6. `preferredColumn` 解决了什么问题？什么时候清掉它？
7. Markdown 的块和行内格式有什么区别？为什么要先识别代码块？
8. `renderInline` 怎样决定先处理哪个格式？为什么行内代码不递归处理？
9. 流式输出时，Markdown 渲染要注意哪些情况？

<details>
<summary>参考答案</summary>

1. 把"按了哪个键"和"要做什么"分开：组件只认动作，按键可以集中修改、由用户配置。`satisfies` 检查对象的形状，同时保留它的键名，这样 `keyof typeof` 能得到所有动作名组成的联合类型。
2. 大多数终端里 Enter 和 Shift+Enter 送来的都是 `\r`，程序分不出来。替代办法：Alt+Enter、Ctrl+J，以及在行尾输入 `\` 再按回车。
3. 一个行的数组加上光标的行号和列（字符串下标）。在行首按退格：把当前行接到上一行后面，删掉当前行，光标移到原来上一行的末尾。
4. 一个逻辑行折行之后的一段。光标的位置是逻辑行里的下标，要知道光标画在哪个屏幕行的哪一列、上下移动到哪里，都需要屏幕行在逻辑行里的位置。
5. 算作下一个屏幕行的开头，否则它会画在上一行的末尾，超出宽度；只有逻辑行的最后一段，光标才能停在末尾。
6. 上下移动经过一个短行时，光标会被挤到短行的末尾；记住想去的列，下一次移动还能回到原来的列。按了上下方向键以外的键就清掉。
7. 块由行决定（标题、代码块、列表……），行内格式在一段文字里面（粗体、代码……）。代码块里的内容要原样显示，`#`、`*` 都不能当作格式，所以要最先识别。
8. 每一轮选所有规则里位置最靠前的匹配，同一位置时排在前面的规则优先。行内代码里的 `*`、`_` 是代码本身，不是格式。
9. 代码块可能还没结束；结束标记可能只来了一半，要先隐藏，避免画面跳动；粗体等格式可能还没结束，先原样显示。

</details>

## 10. 对照 pi 源码

- **[keybindings.ts](../../packages/tui/src/keybindings.ts)**：`TUI_KEYBINDINGS` 对应我们的 `DEFAULT_KEYBINDINGS`，每个动作还有一段说明文字（`/hotkeys` 命令显示的帮助就来自这里）。`KeybindingsManager` 会检测冲突（两个动作用了同一个键）。`Keybindings` 是一个可以被其他包**扩展**的接口：coding-agent 在 [src/core/keybindings.ts](../../packages/coding-agent/src/core/keybindings.ts) 里用 `declare module` 给它加上 `app.*` 这些应用级的动作。用户的配置写在 `~/.pi/agent/keybindings.json`，见 [docs/keybindings.md](../../packages/coding-agent/docs/keybindings.md)。
- **[editor.ts](../../packages/tui/src/components/editor.ts)**：两千多行。我们实现了它的骨架：`state.lines`、`cursorLine`、`cursorCol`，`buildVisualLineMap`（我们的 `layout`），`wordWrapLine`（我们的 `wrapPositions`），历史记录（`navigateHistory`，同样是往上翻光标放开头）。它还有：自动补全（输入 `/` 弹出斜杠命令、输入 `@` 补全文件名）、大段粘贴的标记（`[paste #1 +123 lines]`）、剪切环（`KillRing`）、撤销（`UndoStack`，连续输入按词合并）、跳到某个字符（Ctrl+]）、用鼠标点击移动光标、Page Up/Down。上下移动的"记忆列"用一张决策表处理了各种边界情况（`computeVerticalMoveColumn` 上面的注释）。输入框的最大高度是终端高度的 30%。
- **[word-navigation.ts](../../packages/tui/src/word-navigation.ts)**：`findWordBackward`、`findWordForward`，同样基于 `Intl.Segmenter` 的分词模式，多处理了英文标点的边界。
- **[markdown.ts](../../packages/tui/src/components/markdown.ts)**：用 [marked](https://marked.js.org/) 解析成 token，再逐个渲染。它还支持 LaTeX 公式、代码高亮（通过主题提供的 `highlightCode`）、在支持的终端里把链接变成可以点击的超链接（OSC 8）。`trimPartialClosingFences` 就是 4.5 节说的"半个结束标记"。
- **[utils.ts](../../packages/tui/src/utils.ts)**：`wrapTextWithAnsi` 里的 `AnsiCodeTracker` 就是我们的 `StyleTracker`，处理得更完整（一个序列里的多个参数、超链接……）。

## 11. 闭卷挑战

不看资料，写出：

1. 编辑器的 `insertText`、`deleteBefore`、`deleteAfter`（包括行首、行尾合并两行）；
2. `wrapPositions` 和 `cursorRow`；
3. `renderInline` 和粗体、斜体、行内代码三条规则。

让 `test/editor.test.ts` 和 `test/markdown.test.ts` 的大部分测试通过。

---

上一步：[里程碑 17：组件与差分渲染](../17-tui/README.md) · 下一步：[里程碑 19：交互模式](../19-interactive/README.md)
