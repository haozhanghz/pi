import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../src/tui/ansi.ts";
import { Markdown, renderMarkdown } from "../src/tui/components/markdown.ts";
import { visibleWidth } from "../src/tui/width.ts";

/** 渲染并去掉颜色，只看文字 */
function plain(text: string, width = 40): string[] {
	return renderMarkdown(text, width).map(stripAnsi);
}

test("标题和段落：块之间空一行，段落里的换行保留", () => {
	assert.deepEqual(plain("# 标题\n第一行\n第二行\n\n### 小标题"), ["标题", "", "第一行", "第二行", "", "### 小标题"]);
	const [heading] = renderMarkdown("# 标题", 40);
	assert.ok(heading.includes("\x1b[1m") && heading.includes("\x1b[4m"), "一级标题是粗体加下划线");
});

test("行内格式：粗体、斜体、行内代码、删除线、链接", () => {
	const [line] = renderMarkdown("**粗** *斜* `code` ~~删~~ [文档](https://x.dev)", 60);
	assert.equal(stripAnsi(line), "粗 斜 code 删 文档 (https://x.dev)");
	assert.ok(line.includes("\x1b[1m粗\x1b[22m"));
	assert.ok(line.includes("\x1b[3m斜\x1b[23m"));
	assert.ok(line.includes("\x1b[33mcode\x1b[39m"));
	assert.ok(line.includes("\x1b[9m删\x1b[29m"));
});

test("行内格式：snake_case 不是斜体，反斜杠转义，粗体里可以有代码", () => {
	assert.deepEqual(plain("snake_case_name 和 \\*星号\\*"), ["snake_case_name 和 *星号*"]);
	const [line] = renderMarkdown("**运行 `npm test`**", 40);
	assert.equal(stripAnsi(line), "运行 npm test");
	assert.ok(line.includes("\x1b[33mnpm test\x1b[39m"));
});

test("代码块：保留缩进，显示语言", () => {
	assert.deepEqual(plain("```ts\nif (x) {\n  y();\n}\n```"), ["```ts", "  if (x) {", "    y();", "  }", "```"]);
});

test("代码块还没结束（模型还在输出）：只来了一半的结束标记先不显示", () => {
	assert.deepEqual(plain("```\nlet x = 1;\n``"), ["```", "  let x = 1;", "```"]);
	assert.deepEqual(plain("```\nlet x = 1;\n"), ["```", "  let x = 1;", "```"]);
});

test("列表：可以嵌套，有序列表保留编号，折行时和文字对齐", () => {
	assert.deepEqual(plain("- 苹果\n  - 红富士\n* 香蕉\n\n1. 第一步\n2. 第二步"), [
		"- 苹果",
		"  - 红富士",
		"- 香蕉",
		"",
		"1. 第一步",
		"2. 第二步",
	]);
	assert.deepEqual(plain("- 一个很长很长很长的列表项", 12), ["- 一个很长很", "  长很长的列", "  表项"]);
});

test("列表项里可以有代码块", () => {
	assert.deepEqual(plain("1. 运行：\n   ```\n   npm test\n   ```\n2. 完成"), ["1. 运行：", "   ```", "     npm test", "   ```", "2. 完成"]);
});

test("引用：每一行前面加一条竖线", () => {
	assert.deepEqual(plain("> 第一行\n> 第二行"), ["│ 第一行", "│ 第二行"]);
});

test("表格：列宽对齐，表头粗体", () => {
	const lines = renderMarkdown("| 名字 | 说明 |\n| --- | --- |\n| ls | 列出文件 |\n| bash | 运行命令 |", 40);
	assert.deepEqual(lines.map(stripAnsi), [
		"┌──────┬──────────┐",
		"│ 名字 │ 说明     │",
		"├──────┼──────────┤",
		"│ ls   │ 列出文件 │",
		"│ bash │ 运行命令 │",
		"└──────┴──────────┘",
	]);
	assert.ok(lines[1].includes("\x1b[1m"));
});

test("表格太宽：缩窄最宽的列，单元格里的文字折行", () => {
	const lines = plain("| a | b |\n|---|---|\n| 短 | 这是一个非常非常长的单元格 |", 20);
	for (const line of lines) assert.equal(visibleWidth(line), 20, line);
});

test("任何内容在任何宽度下都不会超出宽度", () => {
	const text =
		"# 一个很长的标题，有中文也有 English words\n\n段落 **粗体** `code` 和[链接](https://example.com/very/long/path)。\n\n" +
		"- 列表\n  - 嵌套的列表，内容也很长很长\n\n```\nconst veryLongVariableName = someFunction(argument1, argument2);\n```\n\n" +
		"> 引用里有 **粗体**\n\n| 列 | 列 |\n|---|---|\n| 内容 | 很长很长很长的内容 |\n\n---";
	for (const width of [1, 5, 10, 20, 37]) {
		for (const line of renderMarkdown(text, width)) {
			assert.ok(visibleWidth(line) <= width, `宽度 ${width}：${JSON.stringify(line)}`);
		}
	}
});

test("Markdown 组件：左右留白，内容没变时使用缓存", () => {
	const markdown = new Markdown("**你好**");
	const lines = markdown.render(20);
	assert.deepEqual(lines.map(stripAnsi), [" 你好"]);
	assert.equal(markdown.render(20), lines);
	markdown.setText("**你好**，世界");
	assert.deepEqual(markdown.render(20).map(stripAnsi), [" 你好，世界"]);
});

test("表格可以紧跟在段落后面（模型经常这样写）", () => {
	assert.deepEqual(plain("对比如下：\n| a | b |\n|---|---|\n| 1 | 2 |"), ["对比如下：", "", "┌───┬───┐", "│ a │ b │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"]);
});
