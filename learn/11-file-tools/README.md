# 里程碑 11：文件工具

> 目标：给 agent 装上真正的"手"——`read`、`write`、`edit`、`ls` 四个文件工具。重点不是"调用一下 fs 函数"，而是怎样设计工具，让模型用得好、用不坏。
>
> 完成后你将拥有：`src/tools/` 目录，以及你的第一个 coding agent：`playground/coding-agent.ts`。

```
$ node playground/coding-agent.ts
coding agent 已就绪。模型：fake/fake-model
工作目录：/home/you/my-pi/playground/workspace

你> 写入 hello.js 内容 console.log("hello")
我来写入 hello.js。
> write hello.js（1 行）
  已写入 hello.js

你> 把 hello.js 里的"hello"改成"你好"
我来修改 hello.js。
> edit hello.js（1 处）
  -1 console.log("hello")
  +1 console.log("你好")

你> 把 hello.js 里的"不存在"改成"x"
> edit hello.js（1 处）
  在 hello.js 里找不到 oldText。它必须和文件内容完全一致，包括空格、缩进和换行。
```

## 你将学到

- 工具设计的几条原则：输出有上限、截断要说明、错误要能指导下一步
- 截断：为什么要截断、怎么截断、怎样告诉模型"还有更多"
- `edit` 的精确替换：为什么用 `oldText`/`newText`，而不是行号或 patch
- 换行符（`\r\n`）和 BOM 这两个隐形的坑
- 文件修改队列：并行执行工具时，保护同一个文件
- 自己写一个 diff 算法（最长公共子序列）
- 用临时目录测试文件操作

---

## 1. 问题：工具不只是"调用一下 fs"

里程碑 09 的 `read` 工具只有一行：

```ts
async execute(_id, { path }) {
	return text(await readFile(path, "utf-8"));
}
```

放到真实的项目里，问题马上就来了：

- 模型读了一个 5MB 的日志文件：一百多万个 token，直接超出上下文窗口；就算没超出，一次请求也要花不少钱。
- 路径相对于谁？程序启动的目录，不一定是用户想让 agent 工作的目录。
- 读到一张图片：一堆乱码塞进了上下文。
- 文件不存在：`ENOENT: no such file or directory, open '/home/…'`。模型大概能看懂，但可以说得更清楚。

写文件、改文件的问题更多：模型怎样告诉我们"改哪里"？两个修改同时进行会不会互相覆盖？Windows 的换行符怎么办？这一章逐个解决。

## 2. 工具设计的原则

在写代码之前，先记住几条原则。它们来自 pi 和其他 coding agent 的实践：

1. **输出有上限。** 任何工具的输出都可能大得离谱，必须截断。
2. **截断要说明。** 告诉模型它看到了哪些部分、怎样查看剩下的。否则模型会以为它看到的就是全部。
3. **错误要能指导下一步。** "`oldText` 出现了 2 次，请多包含一些上下文"比"匹配失败"有用得多：模型知道该怎么改。
4. **在描述里写清楚边界。** 写明上限和用法，模型就会主动使用 `offset`、`limit`。
5. **相对路径相对于工作目录。** 每个工具都用一个工厂函数创建，把工作目录传进去：`createReadTool(cwd)`。

第 5 条是这样实现的：

```ts
export function createReadTool(cwd: string): AgentTool<{ path: string; offset?: number; limit?: number }> {
	return {
		name: "read",
		// ……
		async execute(_toolCallId, { path, offset, limit }, signal) {
			const buffer = await readFile(resolvePath(path, cwd));
			// ……
		},
	};
}
```

`cwd` 被 `execute` 函数"记住"了（这叫**闭包**，里程碑 01 学过）。测试时传一个临时目录，正式运行时传用户的项目目录，工具的代码不用改。

[code/src/tools/util.ts](code/src/tools/util.ts) 的 `resolvePath` 还处理了两个小细节：模型有时会照抄用户输入里的 `@src/main.ts`，所以去掉开头的 `@`；`~/` 开头的路径展开成用户主目录。

## 3. 截断：truncate.ts

### 3.1 两个上限

[code/src/tools/truncate.ts](code/src/tools/truncate.ts) 规定了两个上限，先达到哪个算哪个：

```ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
```

为什么要两个？

- **行数上限是给普通文件的**：2000 行足够看懂绝大多数源代码文件，而且"读到第 2000 行就停"很好理解，提示里的行号也好用。
- **字节上限是安全网**：2000 行、每行 1000 个字符的文件有 2MB；压缩过的 JS 文件甚至整个只有一行。这些文件行数上限管不住，字节上限能管住。

### 3.2 按字节计算，只保留完整的行

```ts
for (const line of lines) {
	if (output.length >= maxLines) break;
	// 注意要用字节数，而不是字符数：一个汉字占 3 个字节
	const lineBytes = Buffer.byteLength(line, "utf-8") + (output.length > 0 ? 1 : 0); // +1 是换行符
	if (bytes + lineBytes > maxBytes) {
		truncatedBy = "bytes";
		break;
	}
	output.push(line);
	bytes += lineBytes;
}
```

两个细节：

- `Buffer.byteLength(line, "utf-8")` 算的是字节数。`"汉字".length` 是 2，但它占 6 个字节。上下文窗口和费用跟 token 有关，字节数比字符数更接近 token 数。
- **绝不把一行从中间切断**：半行代码会让模型困惑。如果连第一行都放不下（比如压缩过的 JS），返回 `firstLineExceedsLimit: true`，由调用者决定怎么提示。

`truncateHead` 保留开头的部分，适合读文件（从头开始看）。下一章的 bash 工具需要保留**结尾**的部分（命令的错误信息通常在最后），我们会写一个 `truncateTail`。

## 4. read 工具

完整代码：[code/src/tools/read.ts](code/src/tools/read.ts)。

### 4.1 分页：offset 和 limit

```ts
const allLines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
const totalLines = allLines.length;
const start = offset ? Math.max(0, offset - 1) : 0; // offset 从 1 开始，数组下标从 0 开始
if (start >= totalLines) {
	throw new Error(`offset=${offset} 超出了文件末尾（文件一共 ${totalLines} 行）。`);
}
const end = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;
const truncation = truncateHead(allLines.slice(start, end).join("\n"));
```

先按 `offset`/`limit` 取出模型要的行，再截断。`offset` 从 1 开始，因为人和模型说"第几行"都是从 1 数的。

### 4.2 截断要说明

```ts
if (truncation.firstLineExceedsLimit) {
	const size = formatSize(Buffer.byteLength(allLines[start], "utf-8"));
	output = `[第 ${firstShown} 行有 ${size}，超过了 ${formatSize(DEFAULT_MAX_BYTES)} 的上限，无法显示。可以用 bash 查看一部分：sed -n '${firstShown}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
} else if (truncation.truncated) {
	const lastShown = firstShown + truncation.outputLines - 1;
	const reason = truncation.truncatedBy === "bytes" ? `（达到了 ${formatSize(DEFAULT_MAX_BYTES)} 的上限）` : "";
	output = `${truncation.content}\n\n[显示了第 ${firstShown}-${lastShown} 行，共 ${totalLines} 行${reason}。用 offset=${lastShown + 1} 继续读取。]`;
} else if (end < totalLines) {
	output = `${truncation.content}\n\n[文件还有 ${totalLines - end} 行。用 offset=${end + 1} 继续读取。]`;
} else {
	output = truncation.content;
}
```

读一个 2500 行的文件，模型看到的结尾是：

```
line 1999
line 2000

[显示了第 1-2000 行，共 2500 行。用 offset=2001 继续读取。]
```

提示里直接给出了下一次调用的参数 `offset=2001`，模型照做就行。**好的提示是可以直接执行的。**

### 4.3 为什么不加行号？

有的 agent（比如 Claude Code）读文件时会在每行前面加上行号，像 `cat -n` 那样。好处是模型容易说出"第 12 行有问题"；坏处是模型从读到的内容里复制 `oldText` 时，可能把行号也复制进去，导致匹配失败。pi 选择不加行号，我们也不加。这是一个取舍，没有绝对的对错。

### 4.4 二进制文件、空文件和错误信息

```ts
// 文本文件里不会有值为 0 的字节；有的话，基本可以肯定是二进制文件（图片、压缩包、可执行文件……）
if (buffer.subarray(0, 8192).includes(0)) {
	throw new Error(`${path} 是二进制文件，无法作为文本读取。`);
}
```

只检查前 8KB 就够了。git 也是用类似的办法判断二进制文件的（检查前 8000 个字节里有没有 0）。空文件返回"（空文件）"，而不是一个空字符串：明确的结果比空白更不容易让模型误解。

文件系统的错误交给 `describeFsError` 翻译：

```ts
export function describeFsError(error: unknown, path: string): string {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	switch (code) {
		case "ENOENT":
			return `文件或目录不存在：${path}`;
		case "EISDIR":
			return `${path} 是一个目录，不是文件。可以用 ls 查看目录里有什么`;
		// ……
	}
}
```

Node.js 的文件系统错误都有一个 `code` 属性，比如 `ENOENT`（Error NO ENTry，不存在）、`EISDIR`（是目录）、`EACCES`（没有权限）。注意 `EISDIR` 的提示：顺便告诉模型下一步可以做什么。

## 5. write 工具

完整代码：[code/src/tools/write.ts](code/src/tools/write.ts)。

```ts
await mkdir(dirname(absolutePath), { recursive: true }); // 相当于 mkdir -p
await writeFile(absolutePath, content, "utf-8");
```

很简单，只有两个值得注意的地方：

- 自动创建父目录。模型说"创建 src/utils/format.ts"时，`src/utils` 可能还不存在。
- 描述里写着"只用于创建新文件或者完全重写；修改文件的一部分请用 edit"。为什么？要改 500 行文件里的一行，用 `write` 意味着模型要把 500 行全部重新输出一遍：慢、贵，还可能不小心改坏其他地方。

`withFileMutationQueue` 是什么？第 8 节再讲。

## 6. edit 工具：精确替换

### 6.1 模型怎样告诉我们"改哪里"？

这是 coding agent 设计中最重要的问题之一。几种方案：

| 方案 | 问题 |
| --- | --- |
| 行号："把第 12~15 行换成……" | 模型数行号经常数错；改了一处之后，后面的行号全变了 |
| patch 格式（像 `git diff` 的输出） | 格式要求严格（每段的行数、上下文行），模型很容易写错一点点。（OpenAI 的 Codex 专门训练模型输出一种自己设计的 patch 格式。） |
| 重写整个文件 | 慢、贵、容易误改其他地方 |
| **精确替换**：给出原文里的一段文字和替换后的文字 | 模型非常擅长"复制一段文字"。只要求这段文字在文件里唯一，就能精确定位 |

pi、Claude Code 等主流 agent 都用精确替换。我们的 `edit` 工具的参数：

```json
{
  "path": "math.js",
  "edits": [
    { "oldText": "return a + b;", "newText": "return a + b + 0;" },
    { "oldText": "function sub", "newText": "function minus" }
  ]
}
```

一次可以改好几处，避免为了改一个文件的三个地方调用三次工具。

### 6.2 规则

[code/src/tools/edit.ts](code/src/tools/edit.ts) 的 `applyEdits` 负责检查和替换：

```ts
export function applyEdits(content: string, edits: Edit[], path: string): string {
	const label = (index: number) => (edits.length === 1 ? "oldText" : `edits[${index}].oldText`);
	const matches = edits.map((edit, index) => {
		if (edit.oldText === "") throw new Error(`${label(index)} 不能为空。`);
		const start = content.indexOf(edit.oldText);
		if (start === -1) {
			throw new Error(`在 ${path} 里找不到 ${label(index)}。它必须和文件内容完全一致，包括空格、缩进和换行。`);
		}
		const count = countOccurrences(content, edit.oldText);
		if (count > 1) {
			throw new Error(`${label(index)} 在 ${path} 里出现了 ${count} 次，必须是唯一的。请多包含一些上下文，让它只匹配一处。`);
		}
		return { index, start, end: start + edit.oldText.length, newText: edit.newText };
	});

	// 按位置排序，检查相邻的两处有没有重叠
	matches.sort((x, y) => x.start - y.start);
	for (let k = 1; k < matches.length; k++) {
		if (matches[k - 1].end > matches[k].start) throw new Error(/* edits[i] 和 edits[j] 有重叠…… */);
	}

	// 从后往前替换：替换后面的内容，不会影响前面各处的位置
	let result = content;
	for (const match of matches.toReversed()) {
		result = result.slice(0, match.start) + match.newText + result.slice(match.end);
	}
	if (result === content) throw new Error(`没有修改 ${path}：替换之后的内容和原来完全一样。`);
	return result;
}
```

五条规则，每条都有理由：

1. **`oldText` 不能为空**：空字符串在任何位置都能"匹配"。
2. **必须完全一致**：我们不猜模型的意思。差一个空格也不行——错误信息会告诉模型。
3. **必须唯一**：出现两次时，不知道该改哪一处。错误信息让模型"多包含一些上下文"，比如把 `return a + b;` 扩展成 `function add(a, b) {\n\treturn a + b;`。
4. **所有 `oldText` 都在原文件里查找，并且不能重叠**：模型是根据它读到的原文件写出这些 `oldText` 的。如果一处一处依次应用，前面的修改可能让后面的 `oldText` 找不到了。
5. **替换后必须有变化**：`oldText` 和 `newText` 一样，说明模型搞错了什么，告诉它。

### 6.3 为什么从后往前替换？

假设内容是 `aaa-bbb-ccc`，要把 `aaa`（位置 0~3）换成 `x`，把 `ccc`（位置 8~11）换成 `y`。

- 从前往后：先换 `aaa`，内容变成 `x-bbb-ccc`，`ccc` 的位置变成了 6~9，记下的 8~11 就错了。
- 从后往前：先换 `ccc`，内容变成 `aaa-bbb-y`，`aaa` 的位置 0~3 没有变。

`toReversed()` 返回一个顺序颠倒的新数组（不修改原数组）。

`countOccurrences` 每次从上一个位置的下一个字符开始找，所以连互相重叠的出现也能数到：在 `aaa` 里找 `aa`，会找到两处（位置 0 和 1）。

### 6.4 两个隐形的坑：换行符和 BOM

**换行符**：Windows 上的文件，换行通常是两个字符 `\r\n`；Linux 和 macOS 是一个字符 `\n`。模型写 `oldText` 时总是用 `\n`。如果文件是 `\r\n`，`"第一行\n第二行"` 就永远匹配不上 `"第一行\r\n第二行"`。

**BOM**：有的编辑器（特别是 Windows 上的）会在文件开头写一个看不见的字符 `﻿`，叫 BOM（字节顺序标记）。模型看不见它，`oldText` 里自然也不会有。

解决办法：先统一格式，替换完再还原：

```ts
const bom = raw.startsWith("﻿") ? "﻿" : "";
const content = normalizeToLF(raw.slice(bom.length));   // 去掉 BOM，\r\n 统一成 \n
const lineEnding = detectLineEnding(raw);               // 记住原来用的是哪种换行符
const updated = applyEdits(content, normalizedEdits, path);
await writeFile(absolutePath, bom + restoreLineEndings(updated, lineEnding), "utf-8");
```

这样文件原来是什么格式，修改后还是什么格式。用户用 `git diff` 看的时候，只会看到真正改动的那几行，而不是"整个文件的每一行都变了"。

### 6.5 diff：给人看的修改记录

`edit` 返回的 `details.diff` 是给界面显示的（不发给模型）：

```
  1 function add(a, b) {
- 2     return a + b;
+ 2     return a + b + 0;
  3 }
  4 
  5 function sub(a, b) {
    ...
```

怎样算出哪些行被删除、哪些行是新增的？pi 用了一个叫 `diff` 的库，我们自己写一个：[code/src/tools/diff.ts](code/src/tools/diff.ts)。分三步：

**① 去掉开头和结尾相同的行。** 一次修改通常只改了中间的一小段。一个 1000 行的文件改了第 500 行，去掉前后相同的部分之后，只剩下 1 行对 1 行。

**② 对中间的部分求最长公共子序列（LCS，Longest Common Subsequence）。** 公共子序列就是"两边都有、顺序相同"的那些行。最长公共子序列里的行就是"没变的行"，旧内容里剩下的是"删除的行"，新内容里剩下的是"新增的行"。

例子：旧的是 `A B C D`，新的是 `A C D E`。最长公共子序列是 `A C D`，所以 `B` 被删除了，`E` 是新增的。

求最长公共子序列是一个经典的**动态规划**问题：用一张表记下"旧内容从第 i 行开始、新内容从第 j 行开始，最长公共子序列有多长"，从表的右下角往左上角填：

```ts
for (let i = n - 1; i >= 0; i--) {
	for (let j = m - 1; j >= 0; j--) {
		lcs[i * (m + 1) + j] =
			a[i] === b[j]
				? lcs[(i + 1) * (m + 1) + j + 1] + 1                                  // 这两行相同：都往后走一步，长度 +1
				: Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);   // 不同：跳过一边，取更长的
	}
}
```

（二维的表用一维数组 `Uint32Array` 存，第 i 行第 j 列在下标 `i * (m + 1) + j`。这样比数组的数组省内存，也更快。）

填好表之后从左上角走一遍：两行相同就是"没变"，都往后走；不同就往 LCS 更长的方向走，跳过的那行就是删除或新增。

**③ 编上行号，只显示改动附近的几行**（`formatDiff`），其余的用 `...` 代替。

表的大小是两边行数的乘积。中间部分太大时（超过 400 万个格子），我们放弃计算，直接算作"全部删除、全部新增"。对于 diff 这种只给人看的东西，这样的退路足够了。

## 7. ls 工具

完整代码：[code/src/tools/ls.ts](code/src/tools/ls.ts)。按字母顺序列出目录内容，目录名后面加 `/`，最多 500 项。

```ts
const names = entries
	.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
	.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
```

`readdir(dir, { withFileTypes: true })` 返回的不只是名字，还能直接问每一项"你是不是目录"，不用再一个一个调用 `stat`。

有了下一章的 bash 工具，模型也可以用 `ls`、`find` 命令。pi 的默认工具其实只有 `read`、`bash`、`edit`、`write` 四个。我们保留 `ls`，因为这一章还没有 bash，而且它的输出更规整、有上限。

## 8. 文件修改队列

### 8.1 问题：丢失的修改

上一章我们让工具同时执行。如果模型在一次回复里调用了两次 `edit`，修改**同一个文件**的两个地方：

```
edit #1：读取文件（内容 A）
edit #2：读取文件（内容 A）              ← 两个操作都读到了修改前的内容
edit #1：写入 A + 修改 1
edit #2：写入 A + 修改 2                 ← 修改 1 被覆盖了！
```

两个 `edit` 都成功了，但文件里只有修改 2。这种 bug 很难发现，因为它只在"恰好同时"的时候出现。

### 8.2 解决：每个文件一条队列

[code/src/tools/file-mutation-queue.ts](code/src/tools/file-mutation-queue.ts)：

```ts
const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = queues.get(key) ?? Promise.resolve();
	const result = previous.then(fn); // 等前一个操作完成后，再执行这个操作
	const done = result.then(
		() => {},
		() => {},
	); // 不管成功还是失败，都表示"这个操作结束了"，后面的操作可以开始
	queues.set(key, done);
	try {
		return await result;
	} finally {
		// 如果后面没有新的操作排队，就把这个文件的队列删掉，免得 Map 越来越大
		if (queues.get(key) === done) queues.delete(key);
	}
}
```

核心是 Promise 的链式调用：`previous.then(fn)` 意思是"等 `previous` 完成之后再执行 `fn`"。每来一个新操作，就把它接在队尾，再把自己设为新的队尾。修改同一个文件的操作就排成了一队，修改不同文件的操作各自一队，互不影响。

`done` 为什么要把错误"吞掉"？如果一个操作失败了（比如 `oldText` 找不到），后面排队的操作不应该跟着失败。`done` 无论如何都会成功完成，所以 `previous.then(fn)` 里的 `fn` 总会被执行。而调用者 `await result` 仍然能拿到真正的错误。

`write` 和 `edit` 都把"读、改、写"整个过程放进队列：

```ts
return withFileMutationQueue(absolutePath, async () => {
	throwIfAborted(signal);
	const raw = await readFile(absolutePath, "utf-8");
	// ……替换……
	await writeFile(absolutePath, newContent, "utf-8");
	throwIfAborted(signal);
	// ……
});
```

`test/edit.test.ts` 里的"同时修改同一个文件的两处"测试检查了这一点。你可以做个实验：把 `withFileMutationQueue` 的第一行改成 `return fn();`（跳过排队），再运行这个测试，它会失败。

### 8.3 取消：在每一步之后检查

注意 `write` 里的注释：

```ts
// 注意：这里不在 abort 事件里直接抛出异常，而是在每一步之后检查。
// 否则文件还在写，队列就已经放下一个操作进来了
```

如果用户取消时我们立刻让 `fn` 失败，队列会认为"这个操作结束了"，放下一个操作进来。但真正的 `writeFile` 可能还在进行，两个写操作又撞在一起了。所以我们让正在进行的文件操作完成，然后在下一步之前检查是否已取消。

## 9. 参数的自动修正：JSON 字符串

`edit` 的 `edits` 参数是一个数组。实际使用中，有的模型会把它写成一个 JSON **字符串**：

```json
{ "path": "a.js", "edits": "[{\"oldText\": \"a\", \"newText\": \"b\"}]" }
```

或者只有一处修改时，直接给一个对象，而不是数组。意图很明确，没必要让模型重试。所以我们在 [code/src/agent/validate.ts](code/src/agent/validate.ts) 的 `coerce` 里加了两条规则：

```ts
if (schema.type === "array" || schema.type === "object") {
	const parsed = parseJsonString(value);
	if (typeof parsed === "object" && parsed !== null) value = parsed;
}
// ……
case "array": {
	if (isPlainObject(value)) value = [value];   // 需要数组，给了一个对象：包成数组
	// ……
}
```

这是在通用的校验器里修正，所以对所有工具都有效。

## 10. 运行

[code/playground/coding-agent.ts](code/playground/coding-agent.ts) 在上一章 demo 的基础上，把工具换成了 `createCodingTools(cwd)`，并改进了显示：`write` 只显示文件名和行数（而不是整个文件内容），`edit` 显示彩色的 diff。

为了安全，它默认在 `playground/workspace` 目录里工作（没有就自动创建），不会碰到你的项目文件。

先启动假模型服务器，然后：

```bash
node playground/coding-agent.ts
```

依次输入：

```
写入 hello.js 内容 console.log("hello")
把 hello.js 里的"hello"改成"你好"
读取 hello.js 然后 列出 .
把 hello.js 里的"不存在"改成"x"
```

最后一个会失败，你会看到红色的错误信息，以及假模型对错误的回应。

用真实模型试试：

```bash
node --env-file=.env playground/coding-agent.ts --model deepseek/deepseek-chat
```

- "写一个 fizzbuzz.js，从 1 数到 15"
- "给它加上注释"（观察：它会先 `read`，再用 `edit` 改，而不是整个重写）
- "把范围改成 1 到 30，再把 Fizz 改成 '嘶'"（观察：一次 `edit` 改了两处）

你会发现它写完代码之后没法运行它——它还没有 bash 工具。这是下一章的内容。

想让它改你真正的项目？加上 `--cwd .`。小心：它真的会修改文件。用 git 管理的项目，改坏了可以用 `git checkout` 恢复。

## 11. 用临时目录测试

文件工具的测试要真的读写文件。为了不弄乱你的电脑，每个测试用一个临时目录，测试结束后删掉：

```ts
// test/helpers/temp-dir.ts
export async function makeTempDir(t: TestContext): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "mini-pi-test-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
```

- `mkdtemp` 在系统的临时目录（比如 `/tmp`）里创建一个名字唯一的新目录；
- `realpath` 把路径里的符号链接换成真实的路径。macOS 的临时目录 `/var/folders/...` 其实是 `/private/var/folders/...` 的符号链接，在里面运行的程序用 `process.cwd()` 得到的是后者。后面的测试会比较这两个路径，所以先统一；
- `t.after(...)` 注册一个函数，在这个测试结束后执行（不管测试成功还是失败）。

用法：

```ts
test("读取小文件：返回全部内容", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "a.txt"), "你好\n世界\n");
	assert.equal(await read(dir, { path: "a.txt" }), "你好\n世界");
});
```

这里体现了工厂函数的好处：`createReadTool(dir)` 让工具在临时目录里工作。

## 12. 接口约定与测试

| 文件 | 内容 |
| --- | --- |
| `src/tools/util.ts` | `resolvePath(path, cwd)`、`throwIfAborted(signal)`、`describeFsError(error, path)` |
| `src/tools/truncate.ts` | `DEFAULT_MAX_LINES`、`DEFAULT_MAX_BYTES`、`TruncationResult`、`formatSize(bytes)`、`truncateHead(content, options?)` |
| `src/tools/diff.ts` | `DiffLine`、`diffLines(oldText, newText)`、`formatDiff(lines, contextLines?)` |
| `src/tools/file-mutation-queue.ts` | `withFileMutationQueue(filePath, fn)` |
| `src/tools/read.ts` | `createReadTool(cwd)`、`ReadToolDetails` |
| `src/tools/write.ts` | `createWriteTool(cwd)` |
| `src/tools/edit.ts` | `createEditTool(cwd)`、`applyEdits(content, edits, path)`、`Edit`、`EditToolDetails`、`detectLineEnding`、`normalizeToLF`、`restoreLineEndings` |
| `src/tools/ls.ts` | `createLsTool(cwd)` |
| `src/tools/index.ts` | 导出以上所有内容，以及 `createCodingTools(cwd)` |
| `src/agent/validate.ts` | `coerce` 新增两条规则 |

把参考答案的 `test/` 复制到你的项目，运行 `npm test`。本章新增了 `truncate.test.ts`、`diff.test.ts`、`read.test.ts`、`write.test.ts`、`edit.test.ts`、`ls.test.ts`、`coding-tools.test.ts`，以及 `validate.test.ts` 里的两个测试，还有辅助文件 `test/helpers/temp-dir.ts`。一共 148 个测试。

## 13. 常见错误

| 现象 | 原因 |
| --- | --- |
| 相对路径找不到文件，但文件明明存在 | 用了 `readFile(path)`，路径相对于程序启动的目录，而不是 `cwd`。用 `resolvePath(path, cwd)` |
| 截断后的内容比 50KB 大 | 用 `line.length`（字符数）代替了字节数 |
| 模型反复读同一段内容 | 截断时没有告诉模型怎样继续读，或者提示里的 `offset` 算错了（差了 1） |
| Windows 的文件永远改不了，总是"找不到 oldText" | 没有把 `\r\n` 统一成 `\n` |
| 改过的文件，`git diff` 显示每一行都变了 | 写回去的时候没有还原 `\r\n`，或者丢了 BOM |
| 一次改多处时，后面的修改位置错了 | 从前往后替换了；或者依次应用，而不是都和原文件比对 |
| 并行执行时偶尔丢失修改 | `write` / `edit` 没有用 `withFileMutationQueue`；或者只把"写"放进了队列，"读"在队列外面 |
| 一个 `edit` 失败后，这个文件的所有后续修改都失败 | 队列里存的是 `result` 而不是吞掉错误的 `done` |

## 14. 练习

1. **grep 工具**：写一个 `grep` 工具，在目录里（递归地）搜索包含某段文字的行，输出 `路径:行号: 内容`，跳过 `node_modules` 和 `.git`，最多 100 条结果。超过时提示"结果太多，请缩小范围"。（pi 有一个 grep 工具，用的是 ripgrep。）
2. **宽松匹配**：精确匹配失败时，再试一次"忽略每行末尾的空格"的匹配。想一想：匹配成功后，怎样把替换结果写回原文件，而不破坏其他行末尾原有的空格？（pi 的 `edit-diff.ts` 做了更多：中英文引号、各种破折号、特殊空格都统一处理。）
3. **先读后改**：如果一个文件在这次对话里从来没有被 `read` 过，或者读过之后被别人修改了（修改时间变了），`edit` 拒绝执行，并提示模型先读一遍。提示：`read` 和 `edit` 共用一个 `Map<string, number>`，记录每个文件读取时的修改时间（`stat(path).mtimeMs`）。（Claude Code 就有类似的保护。）
4. **write 也返回 diff**：覆盖已有的文件时，在 `details` 里返回新旧内容的 diff，让界面能显示改了什么。
5. **递归列出**：给 `ls` 加一个 `depth` 参数（默认 1），大于 1 时递归列出子目录，用缩进表示层级。
6. **改进 diff 测试**：写一个测试，验证 `formatDiff` 在两处改动离得很近（中间只隔 2 行）时，不会在它们之间插入 `...`。

## 15. 自测问题

1. 为什么工具的输出要截断？为什么同时需要行数上限和字节上限？
2. 截断时，为什么一定要告诉模型？提示里应该包含什么？
3. 为什么用工厂函数 `createReadTool(cwd)` 创建工具？
4. `edit` 为什么用精确替换，而不是行号？
5. `oldText` 为什么必须唯一？多处替换为什么要都和原文件比对？
6. 为什么要从后往前替换？
7. 换行符和 BOM 会造成什么问题？怎么解决？
8. 不用文件修改队列，并行执行两个 `edit` 会出什么问题？
9. 最长公共子序列和 diff 有什么关系？

<details>
<summary>参考答案</summary>

1. 上下文窗口有限，而且按 token 收费。只限制行数时，行很长的文件仍然可能很大；只限制字节时，可以防住超长的行，但行数上限让结果更可预测。两个上限，先达到哪个算哪个。
2. 否则模型会以为看到的就是全部内容。提示里应该说明看到了哪些部分、一共有多少，以及下一步怎么做（比如 `offset=2001`）。
3. 让相对路径相对于指定的工作目录；测试时可以传入临时目录，工具代码不用改。
4. 模型数行号容易出错，改动之后行号还会变；而复制一段文字是模型很擅长的事，只要文字唯一，就能精确定位。
5. 出现多次时不知道改哪一处。模型是根据原文件写出所有 `oldText` 的，依次应用的话，前面的修改可能让后面的 `oldText` 找不到。
6. 替换会改变后面内容的位置。从后往前替换，前面各处的位置不受影响。
7. 模型写的 `oldText` 用 `\n` 换行，也不包含看不见的 BOM，和文件内容匹配不上。解决办法是先去掉 BOM、统一换行符，替换完再还原。
8. 两个操作都读到修改前的内容，后写入的会覆盖先写入的，第一处修改丢失。
9. 最长公共子序列就是没有变化的行；旧内容里不在其中的行是删除的，新内容里不在其中的行是新增的。

</details>

## 16. 对照 pi 源码

pi 的工具在 [packages/coding-agent/src/core/tools/](../../packages/coding-agent/src/core/tools/)。

- **[read.ts](../../packages/coding-agent/src/core/tools/read.ts)**：和我们的结构一样：先按 `offset`/`limit` 取行，再用 `truncateHead` 截断，然后根据截断的情况生成不同的提示（找 `Use offset=${nextOffset} to continue`）。pi 还支持读取图片：图片作为附件发给模型（支持图片的模型能"看见"它），太大时自动缩小。`resolveReadPathAsync`（在 `path-utils.ts` 里）处理了一些现实中的怪事：macOS 截图的文件名里，"AM/PM" 前面是一个特殊的窄空格；文件名的 Unicode 编码方式（NFD）和用户输入的不一样……找不到文件时，它会依次尝试这些变体。
- **[truncate.ts](../../packages/coding-agent/src/core/tools/truncate.ts)**：同样的两个上限（2000 行、50KB），同样的 `truncateHead`。还有 `truncateTail`（下一章用）和 `truncateMiddle`（保留开头和结尾、去掉中间）。
- **[edit.ts](../../packages/coding-agent/src/core/tools/edit.ts)**：`prepareEditArguments` 处理各种模型的"不规范输出"：`edits` 写成 JSON 字符串、只给一个对象、或者用旧格式把 `oldText`/`newText` 直接放在顶层。注释里点名了具体是哪些模型。
- **[edit-diff.ts](../../packages/coding-agent/src/core/tools/edit-diff.ts)**：`applyEditsToNormalizedContent` 对应我们的 `applyEdits`，错误信息几乎一样（`must be unique`、`overlap`、`No changes made`）。精确匹配失败时，`fuzzyFindText` 会用 `normalizeForFuzzyMatch` 再试一次：去掉行尾空格，统一中英文引号、破折号和特殊空格（练习 2）。`generateDiffString` 生成带行号的 diff，和我们的 `formatDiff` 格式相同，用的是 `diff` 库。
- **[file-mutation-queue.ts](../../packages/coding-agent/src/core/tools/file-mutation-queue.ts)**：思路和我们一样，多了两点：用 `realpath` 得到文件的真实路径，这样通过符号链接访问同一个文件也会排进同一个队列；因为求真实路径是异步的，又加了一个 `registrationQueue`，保证"排队"这个动作本身也按顺序进行。
- **`Operations` 接口**：pi 的每个工具都有一个 `ReadOperations`、`WriteOperations` 之类的接口，把"读文件""写文件"这些操作抽象出来。默认用本地文件系统，换成别的实现，工具就能操作远程机器（比如通过 SSH）上的文件。这是一个为扩展而设计的好例子。

## 17. 闭卷挑战

不看资料，写出：

1. `truncateHead`（按字节计算、只保留完整的行）；
2. `read` 工具的分页和三种提示；
3. `applyEdits` 的五条规则和从后往前替换；
4. `withFileMutationQueue`。

让 `test/truncate.test.ts`、`test/read.test.ts`、`test/edit.test.ts`、`test/write.test.ts` 全部通过。`diff.ts` 可以先跳过，学有余力再挑战。

---

上一步：[里程碑 10：Agent 类](../10-agent-class/README.md) · 下一步：[里程碑 12：bash 工具](../12-bash/README.md)
