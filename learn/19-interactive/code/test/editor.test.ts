import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../src/tui/ansi.ts";
import { Editor } from "../src/tui/components/editor.ts";
import { KeyBuffer } from "../src/tui/keys.ts";
import { CURSOR_MARKER } from "../src/tui/tui.ts";
import { visibleWidth } from "../src/tui/width.ts";

/** 模拟按键：把数据切成一个个按键交给编辑器 */
function press(editor: Editor, data: string): void {
	const keys = new KeyBuffer();
	for (const key of [...keys.push(data), ...keys.flush()]) editor.handleInput(key);
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

test("输入多行：Ctrl+J 和 Alt+Enter 换行", () => {
	const editor = new Editor();
	press(editor, "第一行\n第二行\x1b\r第三行");
	assert.equal(editor.getText(), "第一行\n第二行\n第三行");
	assert.deepEqual(editor.getCursor(), { line: 2, col: 3 });
});

test("回车提交：去掉首尾空白，清空输入框", () => {
	const editor = new Editor();
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	press(editor, "  你好  \r");
	assert.deepEqual(submitted, ["你好"]);
	assert.equal(editor.getText(), "");
});

test("行尾的反斜杠加回车：换行而不是提交", () => {
	const editor = new Editor();
	let submitted = false;
	editor.onSubmit = () => {
		submitted = true;
	};
	press(editor, "第一行\\\r第二行");
	assert.equal(editor.getText(), "第一行\n第二行");
	assert.equal(submitted, false);
});

test("退格和删除：按字形簇删除，在行首、行尾时合并两行", () => {
	const editor = new Editor();
	press(editor, "a👍🏽\nb");
	press(editor, `${LEFT}\x7f`); // 光标移到 b 前面，退格：和上一行合并
	assert.equal(editor.getText(), "a👍🏽b");
	press(editor, "\x7f"); // 再退格：删掉整个 emoji
	assert.equal(editor.getText(), "ab");
	press(editor, "\n");
	press(editor, `${UP}\x05\x1b[3~`); // 回到第一行行尾，Delete：和下一行合并
	assert.equal(editor.getText(), "ab");
});

test("左右移动可以跨行", () => {
	const editor = new Editor();
	press(editor, "ab\ncd");
	press(editor, `${LEFT}${LEFT}${LEFT}`);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	press(editor, RIGHT);
	assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
});

test("按词移动和删除，中文也能按词处理", () => {
	const editor = new Editor();
	press(editor, "hello world, 你好世界");
	press(editor, "\x17"); // Ctrl+W：删除前面一个词
	assert.equal(editor.getText(), "hello world, 你好");
	press(editor, "\x1bb"); // Alt+B：移到前一个词的开头
	assert.deepEqual(editor.getCursor(), { line: 0, col: 13 });
	press(editor, "\x1bb\x1bb");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
	press(editor, "\x1bf"); // Alt+F：移到这个词的末尾
	assert.deepEqual(editor.getCursor(), { line: 0, col: 11 });
});

test("Ctrl+U 删除到行首，Ctrl+K 删除到行尾", () => {
	const editor = new Editor();
	press(editor, "hello world");
	press(editor, "\x1bb\x15");
	assert.equal(editor.getText(), "world");
	press(editor, `${RIGHT}\x0b`);
	assert.equal(editor.getText(), "w");
});

test("上下移动：在折行之间移动，尽量保持同一列", () => {
	const editor = new Editor();
	press(editor, "aaaa bbbb cccc");
	assert.deepEqual(editor.render(12).map(stripAnsi).slice(1, 3), [" aaaa bbbb ", " cccc"], "折行处的空格挂在上一行末尾");
	press(editor, UP);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
	press(editor, DOWN);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 14 });
});

test("上下移动：经过短行之后回到原来的列", () => {
	const editor = new Editor();
	press(editor, "long line here\nab\nlong line again");
	editor.render(40);
	press(editor, `${UP}${UP}\x01${"\x1b[C".repeat(10)}`);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
	press(editor, DOWN);
	assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
	press(editor, DOWN);
	assert.deepEqual(editor.getCursor(), { line: 2, col: 10 });
});

test("历史记录：在第一行按上方向键翻看，按下方向键回到正在输入的内容", () => {
	const editor = new Editor();
	editor.addToHistory("one");
	editor.addToHistory("two");
	editor.render(40);
	press(editor, "draft");
	press(editor, UP);
	assert.equal(editor.getText(), "draft", "第一次按上：先移到行首");
	press(editor, UP);
	assert.equal(editor.getText(), "two");
	press(editor, UP);
	assert.equal(editor.getText(), "one");
	press(editor, UP);
	assert.equal(editor.getText(), "one", "已经是最早的一条");
	press(editor, DOWN);
	assert.equal(editor.getText(), "two");
	press(editor, DOWN);
	assert.equal(editor.getText(), "draft");
});

test("粘贴：保留换行，统一换行符，制表符变成空格", () => {
	const editor = new Editor();
	press(editor, "\x1b[200~if (x) {\r\n\treturn;\r\n}\x1b[201~");
	assert.equal(editor.getText(), "if (x) {\n    return;\n}");
});

test("渲染：上下两条横线；有焦点时输出光标标记；每一行都不超过宽度", () => {
	const editor = new Editor();
	press(editor, "你好世界你好 hello world");
	editor.focused = true;
	const lines = editor.render(10);
	assert.equal(stripAnsi(lines[0]), "─".repeat(10));
	assert.equal(stripAnsi(lines.at(-1) ?? ""), "─".repeat(10));
	assert.deepEqual(lines.slice(1, -1).map(stripAnsi), [" 你好世界", " 你好 ", " hello ", " world "]);
	assert.ok(lines.at(-2)?.includes(CURSOR_MARKER));
	for (const line of lines) assert.ok(visibleWidth(line) <= 10, JSON.stringify(line));
});

test("渲染：内容超过最大高度时滚动，横线上显示隐藏了几行", () => {
	const editor = new Editor({ maxHeight: 3 });
	press(editor, "1\n2\n3\n4\n5");
	const lines = editor.render(20).map(stripAnsi);
	assert.deepEqual(lines.slice(1, -1), [" 3", " 4", " 5"]);
	assert.match(lines[0], /↑ 还有 2 行/);
	press(editor, `${UP}${UP}${UP}${UP}`);
	const top = editor.render(20).map(stripAnsi);
	assert.deepEqual(top.slice(1, -1), [" 1", " 2", " 3"]);
	assert.match(top.at(-1) ?? "", /↓ 还有 2 行/);
});
