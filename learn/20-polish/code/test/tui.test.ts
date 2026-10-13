import assert from "node:assert/strict";
import { test } from "node:test";
import { Input } from "../src/tui/components/input.ts";
import { Text } from "../src/tui/components/text.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui/tui.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

/** 直接返回给定的几行，方便测试 */
class Lines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
}

function setup(lines: string[], columns = 20, rows = 5) {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const content = new Lines(lines);
	tui.addChild(content);
	tui.start();
	tui.renderNow();
	return { terminal, tui, content };
}

test("第一次渲染：从光标所在的位置开始，把所有行写到屏幕上", () => {
	const { terminal, tui } = setup(["第一行", "\x1b[31msecond\x1b[39m"]);
	assert.deepEqual(terminal.getScreen(), ["第一行", "second", "", "", ""]);
	assert.equal(tui.fullRedraws, 1);
	assert.ok(terminal.writes[0].includes("second\x1b[39m\x1b[0m"), "每一行末尾都加上了 RESET");
	tui.stop();
});

test("差分渲染：只重画变化了的行", () => {
	const { terminal, tui, content } = setup(["aaa", "bbb", "ccc"]);
	content.lines = ["aaa", "BBB", "ccc"];
	terminal.writes.length = 0;
	tui.renderNow();
	assert.deepEqual(terminal.getScreen().slice(0, 3), ["aaa", "BBB", "ccc"]);
	const written = terminal.writes.join("");
	assert.match(written, /BBB/);
	assert.doesNotMatch(written, /aaa|ccc/, "没变的行不应该重新输出");
	assert.equal(tui.fullRedraws, 1);
	tui.stop();
});

test("什么都没变：一个字节都不写", () => {
	const { terminal, tui } = setup(["aaa", "bbb"]);
	terminal.writes.length = 0;
	tui.renderNow();
	assert.equal(terminal.writes.length, 0);
	tui.stop();
});

test("内容变多：只输出新增的行", () => {
	const { terminal, tui, content } = setup(["aaa", "bbb"]);
	content.lines = ["aaa", "bbb", "ccc", "ddd"];
	terminal.writes.length = 0;
	tui.renderNow();
	assert.deepEqual(terminal.getScreen(), ["aaa", "bbb", "ccc", "ddd", ""]);
	assert.doesNotMatch(terminal.writes.join(""), /aaa|bbb/);
	tui.stop();
});

test("内容变少：多出来的旧行被清掉", () => {
	const { terminal, tui, content } = setup(["aaa", "bbb", "ccc"]);
	content.lines = ["aaa"];
	tui.renderNow();
	assert.deepEqual(terminal.getScreen(), ["aaa", "", "", "", ""]);
	content.lines = ["aaa", "xxx"];
	tui.renderNow();
	assert.deepEqual(terminal.getScreen(), ["aaa", "xxx", "", "", ""]);
	tui.stop();
});

test("内容超过一屏：上面的行滚进历史记录，改动屏幕上的行仍然是差分渲染", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	const { terminal, tui, content } = setup(lines);
	assert.deepEqual(terminal.getScrollback(), ["line 0", "line 1", "line 2"]);
	assert.deepEqual(terminal.getScreen(), ["line 3", "line 4", "line 5", "line 6", "line 7"]);

	content.lines = lines.map((line) => (line === "line 4" ? "LINE 4" : line));
	tui.renderNow();
	assert.deepEqual(terminal.getScreen(), ["line 3", "LINE 4", "line 5", "line 6", "line 7"]);
	assert.equal(tui.fullRedraws, 1);

	content.lines = [...content.lines, "line 8"];
	tui.renderNow();
	assert.deepEqual(terminal.getScreen(), ["LINE 4", "line 5", "line 6", "line 7", "line 8"]);
	assert.deepEqual(terminal.getScrollback(), ["line 0", "line 1", "line 2", "line 3"]);
	assert.equal(tui.fullRedraws, 1);
	tui.stop();
});

test("改动已经滚进历史记录的行：清空屏幕和历史记录，全部重画", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	const { terminal, tui, content } = setup(lines);
	content.lines = lines.map((line) => (line === "line 1" ? "LINE 1" : line));
	tui.renderNow();
	assert.equal(tui.fullRedraws, 2);
	assert.deepEqual(terminal.getAllLines(), content.lines);
	tui.stop();
});

test("内容缩短到屏幕以上：全部重画", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	const { terminal, tui, content } = setup(lines);
	content.lines = ["line 0", "line 1"];
	tui.renderNow();
	assert.equal(tui.fullRedraws, 2);
	assert.deepEqual(terminal.getAllLines(), ["line 0", "line 1"]);
	tui.stop();
});

test("窗口大小改变：重新折行，全部重画", () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TUI(terminal);
	tui.addChild(new Text("一二三四五六七八九十", 0));
	tui.start();
	tui.renderNow();
	assert.deepEqual(terminal.getAllLines(), ["一二三四五六七八九十"]);
	terminal.resize(10, 5);
	tui.renderNow();
	assert.deepEqual(terminal.getAllLines(), ["一二三四五", "六七八九十"]);
	assert.equal(tui.fullRedraws, 2);
	tui.stop();
});

test("requestRender(true)：清空屏幕全部重画", () => {
	const { terminal, tui } = setup(["aaa"]);
	tui.requestRender(true);
	tui.renderNow();
	assert.equal(tui.fullRedraws, 2);
	assert.deepEqual(terminal.getAllLines(), ["aaa"]);
	tui.stop();
});

test("有一行比终端还宽：先恢复终端，再报错", () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TUI(terminal);
	tui.addChild(new Lines(["x".repeat(21)]));
	tui.start();
	assert.throws(() => tui.renderNow(), /第 0 行有 21 列，超过了终端的宽度 20 列/);
	assert.equal(terminal.started, false);
});

test("光标标记：终端的光标移到标记处，标记本身不会输出", () => {
	const { terminal, tui, content } = setup(["标题", `> 你好${CURSOR_MARKER}`, "footer"]);
	assert.deepEqual(terminal.getCursor(), { x: 6, y: 1 });
	assert.ok(!terminal.writes.join("").includes(CURSOR_MARKER));
	// 只有标记的位置变了（行的内容没变），光标也要跟过去
	content.lines = ["标题", `> ${CURSOR_MARKER}你好`, "footer"];
	tui.renderNow();
	assert.deepEqual(terminal.getCursor(), { x: 2, y: 1 });
	tui.stop();
});

test("按键交给获得焦点的组件；输入监听器可以先拦截", () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TUI(terminal);
	const received: string[] = [];
	const component: Component = { render: () => [], handleInput: (data) => received.push(data) };
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	const stopListening = tui.addInputListener((data) => data === "q");
	terminal.send("aq\x1b[A");
	assert.deepEqual(received, ["a", "\x1b[A"]);
	stopListening();
	terminal.send("q");
	assert.deepEqual(received, ["a", "\x1b[A", "q"]);
	tui.stop();
});

test("多次请求重画只会渲染一次", async () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TUI(terminal);
	let renders = 0;
	tui.addChild({
		render: () => {
			renders++;
			return ["x"];
		},
	});
	tui.start();
	tui.requestRender();
	tui.requestRender();
	tui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(renders, 1);
	tui.stop();
});

test("stop()：光标移到内容的下面，恢复终端", () => {
	const { terminal, tui } = setup(["a", `b${CURSOR_MARKER}`, "c"]);
	assert.equal(terminal.getCursor().y, 1);
	tui.stop();
	assert.deepEqual(terminal.getCursor(), { x: 0, y: 3 });
	assert.equal(terminal.started, false);
});

test("输入框放进 TUI：打字后屏幕更新，终端光标跟着输入的位置走", () => {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TUI(terminal);
	const input = new Input("> ");
	tui.addChild(new Text("标题", 0));
	tui.addChild(input);
	tui.setFocus(input);
	tui.start();
	terminal.send("你好");
	tui.renderNow();
	assert.deepEqual(terminal.getScreen().slice(0, 2), ["标题", "> 你好"]);
	assert.deepEqual(terminal.getCursor(), { x: 6, y: 1 });
	tui.stop();
});
