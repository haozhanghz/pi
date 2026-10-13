import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { inverse, stripAnsi } from "../src/tui/ansi.ts";
import { Input } from "../src/tui/components/input.ts";
import { Loader } from "../src/tui/components/loader.ts";
import { Spacer } from "../src/tui/components/spacer.ts";
import { Text } from "../src/tui/components/text.ts";
import { KeyBuffer } from "../src/tui/keys.ts";
import { CURSOR_MARKER, TUI } from "../src/tui/tui.ts";
import { visibleWidth } from "../src/tui/width.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

/** 模拟按键：把数据切成一个个按键交给输入框 */
function press(input: Input, data: string): void {
	const keys = new KeyBuffer();
	for (const key of [...keys.push(data), ...keys.flush()]) input.handleInput(key);
}

test("Text：按宽度换行，左边留白", () => {
	const text = new Text("hello world foo", 1);
	assert.deepEqual(text.render(8), [" hello", " world", " foo"]);
});

test("Text：上下留白；空文字什么都不画；窗口太窄时减少留白", () => {
	assert.deepEqual(new Text("hi", 0, 1).render(10), ["", "hi", ""]);
	assert.deepEqual(new Text("").render(10), []);
	assert.deepEqual(new Text("abc", 2).render(3), [" a", " b", " c"]);
});

test("Text：文字和宽度都没变时，直接返回上次的结果", () => {
	const text = new Text("hello");
	const first = text.render(10);
	assert.equal(text.render(10), first);
	text.setText("bye");
	assert.notEqual(text.render(10), first);
	assert.deepEqual(text.render(10), [" bye"]);
});

test("Spacer：若干个空行", () => {
	assert.deepEqual(new Spacer(2).render(), ["", ""]);
});

test("Loader：定时换一帧，并请求重画；stop() 之后不再请求", async () => {
	const tui = new TUI(new VirtualTerminal());
	let requests = 0;
	tui.requestRender = () => {
		requests++;
	};
	const loader = new Loader(tui, "思考中");
	assert.equal(stripAnsi(loader.render(30)[0]), " ⠋ 思考中");
	loader.start();
	await sleep(120);
	assert.ok(requests >= 1);
	assert.notEqual(stripAnsi(loader.render(30)[0]), " ⠋ 思考中");
	loader.stop();
	const requestsWhenStopped = requests;
	await sleep(200);
	assert.equal(requests, requestsWhenStopped);
});

test("Input：打字、移动光标、删除", () => {
	const input = new Input();
	press(input, "helo");
	press(input, "\x1b[D"); // 左
	press(input, "l");
	assert.equal(input.getValue(), "hello");
	press(input, "\x01"); // Ctrl+A：回到开头
	press(input, "\x1b[3~"); // Delete：删除光标后面的字
	assert.equal(input.getValue(), "ello");
	press(input, "\x05\x7f"); // Ctrl+E：到末尾；Backspace：删除光标前面的字
	assert.equal(input.getValue(), "ell");
	press(input, "\x1b[D\x15"); // 左，Ctrl+U：删除光标前面的所有内容
	assert.equal(input.getValue(), "l");
});

test("Input：按字形簇移动和删除，不会删掉半个 emoji", () => {
	const input = new Input();
	press(input, "a👍🏽b");
	press(input, "\x1b[D\x7f");
	assert.equal(input.getValue(), "ab");
});

test("Input：回车提交，Esc 触发 onEscape，粘贴的换行变成空格", () => {
	const input = new Input();
	let submitted = "";
	let escaped = false;
	input.onSubmit = (value) => {
		submitted = value;
	};
	input.onEscape = () => {
		escaped = true;
	};
	press(input, "\x1b[200~第一行\n第二行\x1b[201~");
	press(input, "\r");
	assert.equal(submitted, "第一行 第二行");
	press(input, "\x1b");
	assert.ok(escaped);
});

test("Input：有焦点时才输出光标标记和反色的假光标", () => {
	const input = new Input("> ");
	press(input, "ab");
	assert.deepEqual(input.render(20), ["> ab"]);
	input.focused = true;
	assert.deepEqual(input.render(20), [`> ab${CURSOR_MARKER}${inverse(" ")}`]);
	press(input, "\x1b[D");
	assert.deepEqual(input.render(20), [`> a${CURSOR_MARKER}${inverse("b")}`]);
});

test("Input：内容太长时横向滚动，光标始终看得见", () => {
	const input = new Input("> ");
	input.focused = true;
	press(input, "abcdefghij");
	assert.equal(stripAnsi(input.render(8)[0]), "> fghij ");
	press(input, "\x01");
	assert.equal(stripAnsi(input.render(8)[0]), "> abcdef");
	press(input, "你好");
	const line = input.render(8)[0];
	assert.equal(stripAnsi(line), "> 你好ab");
	assert.ok(visibleWidth(line) <= 8);
});
