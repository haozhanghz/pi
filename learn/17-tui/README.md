# 里程碑 17：组件与差分渲染

> 目标：搭一个迷你的终端界面框架。界面由一个个组件组成，每个组件把自己画成几行文字；框架比较前后两次的结果，只重画变化了的行，画面不闪烁。
>
> 完成后你将拥有：`src/tui/tui.ts`（组件、容器、差分渲染）、四个组件（`Text`、`Spacer`、`Loader`、`Input`）、一个能检查"屏幕上显示了什么"的假终端 `test/helpers/virtual-terminal.ts`，以及演示程序 `playground/tui-demo.ts`。

```
$ node playground/tui-demo.ts

 迷你 TUI 演示  输入一句话按回车，Ctrl+C 退出

 你：你好
 助手：你刚才说的是"你好"。这段回答会一个字一个字地出现，就像大
 模型的流式输出一样。注意看最下面一行：每一帧只重画了正在变

> █
 第 86 帧 · 上一次写入 222 字节 · 一共 21960 字节 · 全部重画 1 次
```

## 你将学到

- 组件模型：界面是一棵组件树，每个组件的 `render(width)` 返回几行文字
- 差分渲染：比较前后两帧，只重画变化了的行
- 终端的"主屏幕"和历史记录：哪些行还能改，哪些已经改不了
- 宽度契约：为什么任何一行都不能比终端宽
- 两个光标：用户看到的"假光标"，和输入法需要的"真光标"
- 合并重画请求：每秒最多画 60 次
- 焦点：按键交给谁处理
- 怎样测试终端界面：写一个迷你的终端模拟器

---

## 1. 问题：怎样只更新屏幕的一部分？

上一章的 `progress.ts` 记住自己画了几行，每次把光标移回去，全部重画。三个进度条，这样做没问题。可 coding agent 的界面是这样的：

```
 mini-pi v1.0 · deepseek-chat              ← 标题
 > 帮我修复失败的测试                        ← 对话记录：越来越长，可能有几千行
 我先运行一下测试。
 $ npm test
 │ FAIL test/date.test.ts                   ← 工具的输出：实时更新
 ⠋ 正在工作……                               ← 动画：每 80 毫秒变一次
 ──────────────────────────────
 > 正在输入的内容█                           ← 输入框：每按一个键变一次
 ──────────────────────────────
 ~/project · 上下文 9%                       ← 状态栏
```

要画好它，有三个问题：

1. **组织**：各部分由不同的代码负责（对话记录、动画、输入框……）。谁来决定每一部分画在第几行？一部分变高了，下面的部分怎么办？
2. **效率**：模型每秒送来几十个字，每来一个字都把几千行对话全部重画一遍？又慢又闪。
3. **滚动**：对话比屏幕高的时候，上面的部分会滚出屏幕。滚出去的行还能改吗？

这一章用三个办法解决它们：**组件**、**差分渲染**、**记住屏幕的状态**。

## 2. 组件

### 2.1 组件就是一个 render 方法

```ts
export interface Component {
	render(width: number): string[];
	/** 获得焦点时，按键会交给它 */
	handleInput?(data: string): void;
}
```

`render(width)`：给你一个宽度，返回若干行文字。比如画一条横线的组件：

```ts
const rule: Component = { render: (width) => ["─".repeat(width)] };
```

组件**只负责把自己当前的状态画出来**，不负责"什么时候画""画在第几行"。状态变了（多了一个字、光标移动了），组件调用 `tui.requestRender()` 请求重画，框架会在合适的时候调用所有组件的 `render`，把结果拼起来，再决定往终端写什么。

这种思路叫**界面是状态的函数**：同样的状态，画出来永远是同样的几行。很多界面框架（比如网页上的 React）都是这个思路。

为什么返回"几行文字"，而不是一个二维的格子？因为我们的界面是从上往下排的一列，每个组件都占满整个宽度。一行一行的文字最容易拼接，也最容易比较。pi 也是这样设计的。

### 2.2 容器：把组件排成一列

```ts
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) this.children.splice(index, 1);
	}

	clear(): void {
		this.children = [];
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(width)) lines.push(line);
		}
		return lines;
	}
}
```

容器本身也是一个组件，所以容器里可以再放容器，组成一棵树。演示程序的界面是这样的：

```
TUI（根容器）
├── Text        标题
├── Container   对话记录
│   ├── Text    你：你好
│   ├── Loader  ⠋ 思考中……（回答出来之后被移除）
│   └── Text    助手：……
├── Spacer      一个空行
├── Input       输入框
└── status      状态栏（一个有 render 方法的普通对象）
```

对话记录里多了一条消息，就是 `messages.addChild(...)`；下面的输入框和状态栏自动往下移，不需要任何人去算"输入框现在在第几行"。

> 为什么不用 `lines.push(...child.render(width))`？展开运算符会把数组的每个元素当作一个参数传给 `push`，元素太多（几十万行）时会超出参数个数的上限而报错。用循环最稳妥。

### 2.3 宽度契约：任何一行都不能比终端宽

这是整个框架最重要的规则。为什么？

假设终端宽 10 列，某个组件返回了一行 `abcdefghijkl`（12 列）。终端写到第 10 列之后会**自动换行**，把 `kl` 写到下一行。于是这一"行"在屏幕上占了两行，而框架以为它只占一行。之后框架每次计算"把光标往上移几行"都会差一行，画面越画越乱。

所以 `render(width)` 返回的每一行，显示宽度都必须 ≤ `width`。组件要用上一章的 `wrapText`（换行）或 `truncateToWidth`（截断）处理自己的内容。框架在输出每一行之前检查一遍，违反了就**恢复终端、直接报错**：

```
Error: 第 0 行有 21 列，超过了终端的宽度 20 列。组件 render(width) 返回的每一行都不能比 width 宽，请用 truncateToWidth() 或 wrapText() 处理。
```

与其让画面悄悄地乱掉、让你猜半天是哪里出了问题，不如马上停下来，告诉你是哪一行。这叫**尽早失败**（fail fast）。

## 3. 差分渲染

### 3.1 最笨的办法：每次全部重画

清空屏幕，把所有行重新写一遍。问题：

- **慢**：对话有 3000 行，模型每送来一个字，就要写 3000 行。
- **闪**：清空之后、写完之前，屏幕可能有一瞬间是空的（同步输出能缓解，但不是所有终端都支持）。
- **历史记录被破坏**：内容比屏幕高时，每次重画都会把内容再往历史记录里推一遍。

### 3.2 只重画变化了的行

框架记住上一次画出来的所有行（`previousLines`）。这一次画完，逐行比较，找到**第一个**和**最后一个**变化的行，只重画这一段。

一个具体的例子（演示程序里，助手的回答多了几个字，状态栏的帧数加了一）：

```
行号  上一帧                这一帧
 0    标题                  标题
 1    你：你好              你：你好
 2    助手：你刚才说        助手：你刚才说的是       ← 第一个变化的行
 3
 4    > █                   > █
 5    第 85 帧              第 86 帧                 ← 最后一个变化的行
```

终端的光标现在停在第 4 行（输入框的位置，见第 4 节）。框架输出的内容是这样的（真实的输出，为了看清楚加了空格和换行）：

```
\x1b[?2026h                 同步输出开始
\x1b[2A \r                  光标上移 2 行到第 2 行，回到行首
\x1b[2K 助手：你刚才说的是 \x1b[0m   清除这一行，写新的内容
\r\n \x1b[2K \x1b[0m                第 3 行
\r\n \x1b[2K > \x1b[7m \x1b[27m \x1b[0m   第 4 行
\r\n \x1b[2K 第 86 帧 \x1b[0m       第 5 行
\x1b[1A \x1b[3G             光标移回输入框的位置（第 4 行第 2 列）
\x1b[?2026l                 同步输出结束
```

第 0、1 行没有动。第 3、4 行其实没变，但它们夹在两个变化的行中间，顺手一起重画更简单。如果第 5 行下面还有没变的行，就不用管了。

要做到这一点，框架必须**时刻知道终端的光标在第几行**（`cursorRow`），才能算出"往上移几行"。每次输出之后都要更新它。

### 3.3 三种情况

**有行变了**：用光标移动到第一个变化的行，往下重画到最后一个变化的行。

**内容变多了**：比如对话里多了一条消息。新增的行在屏幕上**还不存在**。能不能用 `\x1b[B`（光标下移）过去？不能：光标下移到了屏幕最下面一行就停住了，不会滚动，也不会创造新行。只有**换行**（`\n`）在最下面一行时会让屏幕向上滚动、出现一个新的空行。所以要先移到原来的最后一行，再输出 `\r\n`：

```
上一帧 3 行，这一帧 4 行，光标在第 2 行：
  \r\n               换到新的第 3 行（在屏幕底部时，屏幕向上滚动一行）
  \x1b[2K ddd        写新的一行
```

**内容变少了**：比如加载动画被移除了。多出来的旧行要清掉（`\x1b[2K`），不然它们会留在屏幕上。

合在一起：

```ts
private diffRender(lines: string[], width: number, height: number): string {
	const previous = this.previousLines;
	let first = 0;
	while (first < lines.length && first < previous.length && lines[first] === previous[first]) first++;
	if (first === lines.length && first === previous.length) return ""; // 什么都没变

	// 屏幕上能看到的第一行。变化发生在它上面（已经滚进历史记录）的话，只能清空屏幕全部重画
	const firstVisibleRow = Math.max(0, this.bottomRow - height + 1);
	if (first < firstVisibleRow) return this.fullRedraw(lines, width, true);

	// 最后一个变化的行。行数没变时，它下面的行都不用动；行数变了，后面的行都要重画（或者清掉）
	const end = Math.max(lines.length, previous.length);
	let last = end - 1;
	if (lines.length === previous.length) {
		while (last > first && lines[last] === previous[last]) last--;
	}

	let output: string;
	if (first < previous.length || first === 0) {
		// 这一行已经在屏幕上了：用光标移动过去
		output = `${moveRows(first - this.cursorRow)}\r`;
	} else {
		// 新增的行在屏幕上还不存在：先到原来的最后一行，再用 \r\n 换到下一行
		output = `${moveRows(previous.length - 1 - this.cursorRow)}\r\n`;
	}
	for (let row = first; row <= last; row++) {
		if (row > first) output += "\r\n";
		// 先清除这一行原来的内容再写。内容变少时，多出来的旧行只清除、不写
		output += clearLine + (row < lines.length ? this.checkWidth(lines[row], row, width) : "");
	}
	this.cursorRow = last;
	this.bottomRow = Math.max(this.bottomRow, last);
	return output;
}
```

`moveRows(n)`：n 是正数就下移 n 行（`\x1b[nB`），负数就上移（`\x1b[nA`），0 什么也不输出。

注意循环里重画的行之间用 `\r\n`，而不是 `\x1b[1B`。这对已经存在的行和新增的行都适用：已经存在的行，`\r\n` 只是移到下一行；新增的行，`\r\n` 在屏幕底部时会让屏幕滚动。

### 3.4 主屏幕和历史记录

我们的界面画在终端的**主屏幕**上（vim、less 这类程序会切换到另一个"备用屏幕"，退出时再切回来）。好处是：内容比屏幕高时，上面的行滚进终端的**历史记录**，用户可以用鼠标滚轮往回看；退出程序之后，整个对话还留在终端里。pi 就是这样做的。

代价是：**滚进历史记录的行，光标再也回不去了**。`\x1b[A` 上移到屏幕最上面一行就停住了。举个例子，终端高 5 行，内容有 8 行：

```
历史记录   line 0      ← 光标到不了，改不了
           line 1
           line 2
屏幕       line 3      ← firstVisibleRow = 3
           line 4
           line 5
           line 6
           line 7      ← bottomRow = 7
```

框架怎么知道哪些行还在屏幕上？它记住光标**到过的最下面一行** `bottomRow`。屏幕显示的是到 `bottomRow` 为止的最后 `height` 行，所以屏幕上的第一行是：

```ts
const firstVisibleRow = Math.max(0, this.bottomRow - height + 1);
```

如果第一个变化的行比 `firstVisibleRow` 还靠上，光标到不了，只能**全部重画**：清空屏幕和历史记录（`\x1b[2J\x1b[H\x1b[3J`），把所有行重新写一遍，历史记录也随之重建。

为什么记的是"到过的最下面一行"，而不是"内容的最后一行"？因为内容变少时，屏幕不会往回滚。上面的例子里，如果内容从 8 行变成 6 行，屏幕上仍然是第 3~7 行（第 6、7 行变成了空行），`firstVisibleRow` 还是 3。

> 第一次渲染时，界面从光标当前所在的行开始画，上面可能还有 shell 的内容。这时公式还对吗？对的：内容还没填满屏幕时，`firstVisibleRow` 是 0，所有行确实都在屏幕上；一旦填满，内容的最下面一行一定在屏幕底部，公式就成立了。

### 3.5 什么时候全部重画

| 情况 | 怎么画 |
| --- | --- |
| 第一次渲染 | 从光标所在的位置往下写所有行，不清屏 |
| 窗口宽度变了 | 折行全变了，清空重画 |
| 窗口高度变了 | `firstVisibleRow` 的计算依赖高度，清空重画最简单 |
| 变化发生在历史记录里 | 光标到不了，清空重画 |
| `requestRender(true)` | 调用者要求的（比如运行完一个弄乱了屏幕的外部程序） |
| 其他 | 差分渲染 |

```ts
private doRender(): void {
	const width = this.terminal.columns;
	const height = this.terminal.rows;
	const { lines, cursor } = extractCursor(this.render(width));

	let output: string;
	if (this.previousWidth === 0) {
		output = this.fullRedraw(lines, width, false); // 第一次渲染：直接从光标所在的位置往下画
	} else if (this.forceFullRedraw || width !== this.previousWidth || height !== this.previousHeight) {
		output = this.fullRedraw(lines, width, true); // 窗口大小变了：折行全变了，清空重画
	} else {
		output = this.diffRender(lines, width, height);
	}
	// 画了东西，或者光标标记换了位置：把终端的光标移到标记处
	const cursorMoved = cursor?.row !== this.previousCursor?.row || cursor?.col !== this.previousCursor?.col;
	if (output !== "" || cursorMoved) output += this.placeCursor(cursor, height);

	if (output !== "") this.terminal.write(SYNC_START + output + SYNC_END);
	this.previousLines = lines;
	this.previousWidth = width;
	this.previousHeight = height;
	this.previousCursor = cursor;
	this.forceFullRedraw = false;
}
```

`fullRedraw` 很简单：需要的话先清屏，然后用 `\r\n` 把所有行连起来写出去，`cursorRow` 和 `bottomRow` 都设为最后一行。

### 3.6 每一行末尾的 RESET

`extractCursor` 在每一行的末尾加上 `\x1b[0m`。为什么？上一章说过，样式会一直"开着"直到被关闭。如果某个组件忘了关闭颜色，颜色会漏到下一行，甚至漏到清除行的操作里（`\x1b[2K` 用当前的背景色填充被清除的部分）。在每行末尾统一重置，一个组件的错误就不会影响别的组件。

## 4. 两个光标

### 4.1 隐藏真光标，画一个假光标

终端的光标（"真光标"）标记的是"下一个字写在哪里"。渲染时框架不停地移动它：移到第一个变化的行、往下写、再移回来……如果它是可见的，你会看到它在屏幕上跳来跳去。

所以 `ProcessTerminal.start()` 一开始就隐藏了真光标（`\x1b[?25l`）。输入框自己画一个"假光标"：把光标所在的那个字用反色（`\x1b[7m`）显示。

### 4.2 输入法需要真光标

问题来了：用中文输入法打字时，候选词窗口会出现在**真光标**的位置——即使它是隐藏的。如果真光标停在最后画的那一行的末尾，候选词窗口就会出现在屏幕的左下角，离输入框很远。

解决办法：输入框在光标的位置输出一个**光标标记**：

```ts
export const CURSOR_MARKER = "\x1b_pi:c\x1b\\";
```

它是一个 APC 控制序列（`ESC _` 开头、`ESC \` 结尾）：不占位置，`visibleWidth` 把它当作 0 列，就算漏到终端里，终端也会忽略它。框架渲染时：

1. 在所有行里找到标记，记下它的位置：`> 你好${CURSOR_MARKER}` 的列号是 `visibleWidth("> 你好")`，也就是 6；
2. 把标记删掉，再比较、输出；
3. 输出完之后，把真光标移到那个位置：`\x1b[nA`（或 `B`）移到那一行，`\x1b[7G` 移到第 6 列（`G` 的列号从 1 开始数）。

```ts
private placeCursor(cursor: CursorPosition | undefined, height: number): string {
	if (!cursor) return "";
	const firstVisibleRow = Math.max(0, this.bottomRow - height + 1);
	if (cursor.row < firstVisibleRow) return ""; // 标记已经滚出了屏幕，光标过不去
	const output = moveRows(cursor.row - this.cursorRow) + cursorToColumn(cursor.col);
	this.cursorRow = cursor.row;
	return output;
}
```

注意最后更新了 `cursorRow`：下一次渲染要从这里出发计算移动的距离。

## 5. 什么时候重画

### 5.1 合并重画请求

模型流式输出时，每秒可能送来上百个小片段，每个片段都会调用一次 `requestRender()`；加载动画每 80 毫秒请求一次；用户每按一个键也请求一次。如果每次请求都马上渲染，大部分工作都是白费的——人眼根本看不出每秒 60 次以上的变化。

所以 `requestRender()` 只是**预约**一次渲染：

```ts
requestRender(force = false): void {
	if (force) this.forceFullRedraw = true;
	if (!this.running || this.renderTimer) return; // 已经预约过了
	const wait = Math.max(0, this.lastRenderTime + MIN_RENDER_INTERVAL_MS - performance.now());
	this.renderTimer = setTimeout(() => this.renderNow(), wait);
}
```

- 已经有一次预约在等着了：什么也不做。这次的变化会在那次渲染里一起画出来。
- 离上次渲染已经超过 16 毫秒：`wait` 是 0，下一轮事件循环就画。
- 刚画过：等到满 16 毫秒再画。

这样一秒最多画 60 次左右，而且同一时刻的多次请求只画一次。测试里常用 `renderNow()`：取消预约，马上画。

### 5.2 焦点和按键

`TUI.start()` 把自己的 `handleKey` 交给终端。每收到一个按键：

1. 先交给**输入监听器**（`addInputListener`）。返回 `true` 表示处理了，按键不再往下传。全局快捷键（比如 Ctrl+C 退出）就用它实现。
2. 再交给**获得焦点的组件**（`setFocus`）的 `handleInput`。
3. 请求重画——按键多半改变了某个组件的状态。

能获得焦点的组件实现 `Focusable` 接口（一个 `focused` 属性）。`setFocus` 会更新新旧两个组件的 `focused`，组件据此决定画不画光标：界面上可能有好几个输入框，只有获得焦点的那个显示光标。

## 6. 四个组件

### 6.1 Text：文字

```ts
render(width: number): string[] {
	if (this.cache && this.cache.text === this.text && this.cache.width === width) return this.cache.lines;
	const lines: string[] = [];
	if (this.text !== "") {
		// 窗口很窄时减少留白，保证至少有一列可以放文字
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const margin = " ".repeat(paddingX);
		for (let i = 0; i < this.paddingY; i++) lines.push("");
		for (const line of wrapText(this.text.replaceAll("\t", "   "), width - paddingX * 2)) lines.push(margin + line);
		for (let i = 0; i < this.paddingY; i++) lines.push("");
	}
	this.cache = { text: this.text, width, lines };
	return lines;
}
```

为什么要缓存？框架每一帧都会调用**所有**组件的 `render`。对话记录里可能有几百条消息，而每一帧通常只有最后一条在变。文字和宽度都没变，就直接返回上次的结果，省掉几百次换行计算。

还有一个附带的好处：返回的是**同一个字符串**，框架比较 `lines[i] === previous[i]` 时，两个字符串是同一个对象，比较几乎不花时间。

### 6.2 Spacer：空行

返回若干个空字符串，用来隔开其他组件。

### 6.3 Loader：加载动画

```ts
start(): void {
	this.stop();
	this.timer = setInterval(() => {
		this.frame = (this.frame + 1) % FRAMES.length;
		this.tui.requestRender();
	}, INTERVAL_MS);
}
```

这是**组件自己请求重画**的例子：没有按键、没有新数据，只是时间到了。用完一定要调用 `stop()`：只要还有没清除的定时器，事件循环就还有事要做，Node 就不会退出。

### 6.4 Input：单行输入框

状态只有两个：内容 `value` 和光标位置 `cursor`（`value` 里的下标）。光标总是落在两个**字形簇**之间——向左移动、退格删除都以字形簇为单位，不会把一个 emoji 删掉一半：

```ts
/** 光标左边那个字形簇的开头 */
private previousBoundary(): number {
	const before = splitGraphemes(this.value.slice(0, this.cursor));
	return this.cursor - (before.at(-1)?.length ?? 0);
}
```

`splitGraphemes` 是给 `width.ts` 新加的小函数，用 `Intl.Segmenter` 把文字切成字形簇的数组。

按键处理是一个 `switch`：

```ts
switch (keyId(parseKey(data))) {
	case "enter":
		this.onSubmit?.(this.value);
		return;
	case "left":
	case "ctrl+b":
		this.cursor = this.previousBoundary();
		return;
	// ……backspace、delete、right、home/ctrl+a、end/ctrl+e、ctrl+u、ctrl+k
}
if (isPrintable(data)) this.insert(data);
```

> 按键直接写在代码里，用户没法修改。下一章的多行编辑器有二十多个快捷键，到时候我们会把它们整理成一张可以配置的表。

`render` 要处理**横向滚动**：内容比输入框宽时，只显示光标附近的一段。`scroll` 记住第一个显示出来的字形簇；光标跑到左边看不见的地方，就把 `scroll` 往左挪；光标跑到右边，就往右挪，直到从 `scroll` 到光标的宽度放得下。比如提示符 `> ` 占 2 列，宽度 8，能放内容的只有 6 列：

```
内容 abcdefghij，光标在最后：   > fghij█      （█ 是光标处一个反色显示的空格）
按 Home 回到开头：              > abcdef      （光标在 a 上，a 用反色显示）
```

获得焦点时，在光标处输出 `CURSOR_MARKER` 和反色的假光标；没有焦点就只显示文字。

## 7. 测试界面：一个迷你终端模拟器

怎样测试"屏幕上显示的是不是对的"？

直接比较输出的转义序列？很脆弱：同样的画面有很多种画法（先上移再清除，还是先清除再上移……），改一点实现细节，测试就全挂了，而画面其实没错。

更好的办法：**模拟一个终端**。`test/helpers/virtual-terminal.ts` 实现了 `Terminal` 接口。框架往里写内容时，它像真正的终端一样执行这些控制序列，把结果记在一个字符网格里。测试只检查网格里的文字：

```ts
test("内容超过一屏：上面的行滚进历史记录，改动屏幕上的行仍然是差分渲染", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	const { terminal, tui, content } = setup(lines); // 终端 20 列 × 5 行
	assert.deepEqual(terminal.getScrollback(), ["line 0", "line 1", "line 2"]);
	assert.deepEqual(terminal.getScreen(), ["line 3", "line 4", "line 5", "line 6", "line 7"]);
	// ……
});
```

它只实现了框架用到的那一小部分：

| 输入 | 效果 |
| --- | --- |
| 普通文字 | 按字形簇写进格子，宽字符占两格；写满一行自动换行 |
| `\r` | 回到行首 |
| `\n` | 下移一行；已经在最下面一行时，屏幕向上滚动，最上面的行进入历史记录 |
| `\x1b[nA` `\x1b[nB` `\x1b[nC` `\x1b[nD` | 上下左右移动光标，到了边上就停住 |
| `\x1b[nG` `\x1b[n;mH` | 移到第 n 列；移到第 n 行第 m 列 |
| `\x1b[2K` `\x1b[2J` `\x1b[3J` | 清除一行、清除屏幕、清除历史记录 |
| `\x1b[?25l` `\x1b[?25h` | 隐藏、显示光标 |
| 颜色样式、APC、OSC | 忽略 |

另外它还提供测试用的方法：`send(data)` 模拟按键，`resize(columns, rows)` 模拟改变窗口大小，`getScreen()`、`getScrollback()`、`getAllLines()`、`getCursor()` 读取状态，`writes` 记录每一次写入的原始内容（用来检查"有没有多写"）。

写模拟器的过程会让你真正理解每个控制序列做了什么。有一个细节值得一提：**延迟换行**。在最后一列写了一个字之后，光标并不会马上跳到下一行，而是停在最后一列，等**下一个字**到来时才换行（代码里的 `pendingWrap`）。如果马上换行，一行正好写满时再输出 `\r\n`，就会多出一个空行。真实的终端都是这样做的。

> 写一个"假的东西"代替真实的依赖来做测试，这个思路你已经见过好几次了：假模型服务器、`faux` 服务商、`PassThrough` 代替键盘。这次的假终端稍微复杂一点，因为它要模拟终端的**行为**，而不只是记录调用。

## 8. 运行

```bash
node playground/tui-demo.ts
```

输入一句话按回车。助手先转一会儿圈，然后一个字一个字地回答。试试这些：

1. **看字节数**：回答在流式输出时，状态栏显示每一帧只写了两百多个字节——只有正在变化的那几行。
2. **对比全部重画**：Ctrl+C 退出，换成 `node playground/tui-demo.ts --full` 再聊几句。`--full` 让每一帧都清空屏幕全部重画，每帧写的字节数是原来的好几倍，而且对话越长差距越大。在不支持同步输出的终端里，还能看到画面闪烁。
3. **改变窗口宽度**：拖动窗口边缘，"全部重画"的次数会增加，文字重新折行。
4. **历史记录**：多聊几句，让内容超过一屏，然后用鼠标滚轮往上翻——之前的对话都在。按 Ctrl+C 退出，对话仍然留在终端里，shell 的提示符出现在界面下面。
5. **输入法**：用中文输入法打字，候选词窗口出现在输入框的光标处。把 `tui.ts` 里 `doRender` 调用 `placeCursor` 的那一行注释掉再试试，候选词窗口就跑到别处去了。

`demo` 里有两个值得一看的小技巧：

- `CountingTerminal` 继承 `ProcessTerminal`，重写 `write` 来统计字节数。界面代码只认 `Terminal` 接口，所以可以这样在中间"插一层"。
- 状态栏不是一个类，而是一个有 `render` 方法的普通对象。接口只要求有 `render`，怎么实现都行。

## 9. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/tui/tui.ts` | `Component`、`Focusable`、`CURSOR_MARKER`、`Container`、`InputListener`、`TUI`（`setFocus`、`addInputListener`、`start`、`stop`、`requestRender(force?)`、`renderNow`、`fullRedraws`） |
| `src/tui/components/text.ts` | `Text(text, paddingX = 1, paddingY = 0)`：`getText`、`setText` |
| `src/tui/components/spacer.ts` | `Spacer(lines = 1)` |
| `src/tui/components/loader.ts` | `Loader(tui, message)`：`start`、`stop`、`setMessage` |
| `src/tui/components/input.ts` | `Input(prompt = "> ")`：`focused`、`onSubmit`、`onEscape`、`getValue`、`setValue` |
| `src/tui/width.ts` | 新增 `splitGraphemes`；`visibleWidth` 加了纯 ASCII 的快速路径 |
| `src/tui/ansi.ts` | 新增 `clearScrollback` |
| `test/helpers/virtual-terminal.ts` | `VirtualTerminal`：迷你终端模拟器 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `tui.test.ts`（16 个测试）和 `components.test.ts`（10 个测试），一共 275 个测试。

> `visibleWidth` 的快速路径：框架每输出一行都要量一次宽度，而大部分行是纯英文。`/^[\x20-\x7e]*$/` 检查是不是全是可打印的 ASCII 字符，是的话宽度就是长度，不用再切字形簇。先找出最常被调用的地方再优化，这是优化性能的一般方法。

## 10. 常见错误

| 现象 | 原因 |
| --- | --- |
| 画面越画越乱，每次错开一行 | 某一行超出了终端的宽度，被自动折行了。框架现在会直接报错 |
| 新增的行没有出现，最后一行被反复覆盖 | 用 `\x1b[B` 移到还不存在的行。光标下移到屏幕底部就停住了 |
| 内容变少后，屏幕下面留着旧的内容 | 没有清除多出来的旧行 |
| 没有任何变化，每一帧却都在写 | 某个组件每次 `render` 返回的内容都不一样（比如里面有时间、计数） |
| 改了组件的状态，界面却没有变 | 忘了调用 `tui.requestRender()` |
| 程序不退出 | `Loader` 没有 `stop()`，定时器还在 |
| 输入法的候选词窗口跑到左下角 | 没有输出光标标记，或者计算列号时用了 `.length` 而不是显示宽度 |
| 颜色漏到了下一行 | 行末没有 `RESET` |
| 退出后，shell 的提示符盖住了界面的最后几行 | `stop()` 没有把光标移到内容的下面 |

## 11. 练习

1. **跳过没变的行**：现在第一个和最后一个变化的行之间，没变的行也会重画。改成跳过它们（用 `\x1b[1B` 往下移）。写一个测试：中间的行没有被重新输出。想一想：省下的这点字节，值得多出来的复杂度吗？
2. **边框**：写一个 `Box` 组件，给它的子组件画一个边框（`┌─┐│└─┘`）。子组件的宽度是 `width - 4`（左右各一个边框字符和一个空格）。注意中文内容右边的边框也要对齐。
3. **进度条**：写一个 `ProgressBar` 组件，`setProgress(0.5)` 之后显示 `[██████░░░░░░] 50%`，进度条的长度随窗口宽度变化。用它改写上一章的 `progress.ts`。
4. **输入历史**：给 `Input` 加上历史记录：提交过的内容保存起来，按上下方向键切换。
5. **模拟器加上颜色**：让 `VirtualTerminal` 记录每一格的前景色（处理 `\x1b[31m`、`\x1b[39m`、`\x1b[0m`）。写一个测试：某个组件忘了关闭红色，下一行的文字仍然不是红色的。
6. **思考题**：为什么窗口高度变了也要全部重画？如果不重画，`firstVisibleRow` 会算错吗？举一个例子。

## 12. 自测问题

1. 组件接口有哪两个方法？`render(width)` 的返回值有什么要求？为什么？
2. 差分渲染比较的是什么？怎样确定要重画哪些行？
3. 新增的行为什么要用 `\r\n` 到达，而不能用 `\x1b[B`？
4. 什么情况下必须全部重画？
5. `bottomRow` 记录的是什么？为什么不直接用内容的行数？
6. 为什么要隐藏真光标、画一个假光标？光标标记解决了什么问题？
7. `requestRender()` 为什么不马上渲染？
8. 怎样测试"屏幕上显示的是什么"？为什么不直接比较输出的转义序列？

<details>
<summary>参考答案</summary>

1. `render(width)` 和可选的 `handleInput(data)`。返回的每一行显示宽度都不能超过 `width`，否则终端会自动折行，框架算的行数和屏幕上的实际行数对不上，之后的光标移动全都会错。
2. 比较上一帧和这一帧的每一行。找到第一个和最后一个不同的行，重画它们之间的部分；行数变了的话，从第一个变化的行一直重画到末尾，多出来的旧行清掉。
3. 光标下移到屏幕最下面一行就停住，不会滚动，也不会创造新行；换行在最下面一行时会让屏幕向上滚动，出现一个新行。
4. 第一次渲染（不清屏）；窗口宽度或高度变了；变化发生在已经滚进历史记录的行；调用者要求（`requestRender(true)`）。
5. 光标到过的最下面一行。屏幕显示的是到这一行为止的最后 `height` 行。内容变少时屏幕不会往回滚，所以不能用内容的行数来推算屏幕上显示的是哪些行。
6. 渲染时真光标会被移来移去，可见的话会到处跳。但输入法的候选词窗口跟着真光标走，所以输入框在光标处输出一个不占位置的标记，框架画完之后把（隐藏的）真光标移到那里。
7. 流式输出、动画、按键会非常频繁地请求重画，大部分都是多余的。合并之后同一时刻的请求只画一次，而且每秒最多画 60 次左右。
8. 写一个迷你终端模拟器，执行框架输出的控制序列，检查结果网格里的文字。同样的画面有很多种画法，直接比较转义序列会让测试依赖实现细节。

</details>

## 13. 对照 pi 源码

pi 的界面框架在 [packages/tui](../../packages/tui/)，结构和我们的一样，功能多得多。

- **[tui.ts](../../packages/tui/src/tui.ts)**：`Component` 接口除了 `render` 和 `handleInput`，还有 `handleMouse`（鼠标）、`wantsKeyRelease`（kitty 协议的"松开按键"事件）和 `invalidate`（主题变化时清空缓存）。`Container` 和我们的几乎一样。`TuiBase` 负责焦点、输入监听器（监听器不但能拦截按键，还能改写它：返回 `{ data }`）和**浮层**（`showOverlay`：画在其他内容上面的对话框，可以设置位置、大小、边距，扩展可以用它弹出自己的界面）。pi 内置的选择菜单（选模型、选会话……）用的是更简单的办法：把输入框所在的容器清空，换成选择菜单，选完再换回来（`interactive-mode.ts` 里的 `showSelector`）。里程碑 19 我们也会这样做。
- **[tui-main-screen.ts](../../packages/tui/src/tui-main-screen.ts)**：主屏幕上的差分渲染，读 `doRender` 方法。你会认出 `firstChanged`、`lastChanged`、`previousViewportTop`（我们的 `firstVisibleRow`），以及全部重画的几种情况：宽度变化、高度变化（Termux 除外：手机上弹出软键盘会改变高度，每次都全部重画太烦人了）、`clearOnShrink`、`firstChanged < viewportTop`。追加新行时同样是"移到上一行再 `\r\n`"（`appendStart`）。它还处理了很多我们没处理的情况：终端里显示的图片（kitty 图片协议）、把很大的输出切成 1 MiB 一块再写（`BoundedTerminalWriter`）、行太宽时把所有行写进 `pi-tui-crash.log` 再报错。
- **[tui-alt-screen.ts](../../packages/tui/src/tui-alt-screen.ts)**：pi 的另一种模式，画在备用屏幕上，自己实现滚动和搜索。
- **渲染调度**：`MIN_RENDER_INTERVAL_MS = 16`，和我们一样。不同的是，按键触发的重画走 `requestImmediateRender`，跳过 16 毫秒的限制——打字的延迟最影响手感。
- **光标**：`CURSOR_MARKER = "\x1b_pi:c\x07"`（用 BEL 结尾的 APC）。假光标也用标记包起来（`FAKE_CURSOR_START`/`FAKE_CURSOR_END`），由框架统一换成反色。喜欢真光标的用户可以打开 `showHardwareCursor` 设置（见 [docs/settings.md](../../packages/coding-agent/docs/settings.md)），pi 仍然会为输入法放好它的位置。
- **组件**：[text.ts](../../packages/tui/src/components/text.ts) 会把每一行补齐到整个宽度，并支持背景色；[loader.ts](../../packages/tui/src/components/loader.ts) 继承 `Text`；[input.ts](../../packages/tui/src/components/input.ts) 支持撤销、"剪切环"（Emacs 风格的 Ctrl+K / Ctrl+Y）、按单词移动。`components/` 目录里还有边框、选择列表、设置列表、Markdown、图片……
- **测试**：[test/virtual-terminal.ts](../../packages/tui/test/virtual-terminal.ts) 用的是 xterm.js 的无界面版本（`@xterm/headless`），一个完整的终端模拟器。[tui-render.test.ts](../../packages/tui/test/tui-render.test.ts)、[tui-shrink.test.ts](../../packages/tui/test/tui-shrink.test.ts) 是渲染的测试。

## 14. 闭卷挑战

不看资料，写出：

1. `Component` 接口和 `Container`；
2. `TUI` 的 `diffRender`：找出变化的范围、三种情况、`firstVisibleRow`；
3. 带缓存的 `Text`。

让 `test/tui.test.ts` 的大部分测试通过。

---

上一步：[里程碑 16：终端基础](../16-terminal/README.md) · 下一步：[里程碑 18：输入框与 Markdown](../18-editor/README.md)
