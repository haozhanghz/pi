import assert from "node:assert/strict";
import { test } from "node:test";
import { isPaste, isPrintable, KeyBuffer, keyId, matchesKey, parseKey, pasteContent } from "../src/tui/index.ts";

const id = (sequence: string) => keyId(parseKey(sequence));

test("普通字符、回车、退格、Tab、Esc", () => {
	assert.equal(id("a"), "a");
	assert.equal(id("你"), "你");
	assert.equal(id("\r"), "enter");
	assert.equal(id("\x7f"), "backspace");
	assert.equal(id("\t"), "tab");
	assert.equal(id("\x1b"), "escape");
});

test("方向键和其他功能键，包括不同终端的不同写法", () => {
	assert.equal(id("\x1b[A"), "up");
	assert.equal(id("\x1bOA"), "up");
	assert.equal(id("\x1b[D"), "left");
	assert.equal(id("\x1b[H"), "home");
	assert.equal(id("\x1b[1~"), "home");
	assert.equal(id("\x1b[F"), "end");
	assert.equal(id("\x1b[3~"), "delete");
	assert.equal(id("\x1b[5~"), "pageUp");
});

test("修饰键：Ctrl、Alt、Shift", () => {
	assert.equal(id("\x03"), "ctrl+c");
	assert.equal(id("\x01"), "ctrl+a");
	assert.equal(id("\n"), "ctrl+j");
	assert.equal(id("\x1bb"), "alt+b");
	assert.equal(id("\x1b\r"), "alt+enter");
	assert.equal(id("\x1b[Z"), "shift+tab");
	assert.equal(id("\x1b[1;5C"), "ctrl+right");
	assert.equal(id("\x1b[1;2A"), "shift+up");
	assert.ok(matchesKey("\x03", "ctrl+c"));
	assert.ok(!matchesKey("c", "ctrl+c"));
});

test("一次收到好几个按键：切开", () => {
	const buffer = new KeyBuffer();
	assert.deepEqual(buffer.push("ab\x1b[A你好\r"), ["a", "b", "\x1b[A", "你", "好", "\r"]);
	assert.equal(buffer.pending, false);
});

test("转义序列被拆成了两半：等后半段到了再交出去", () => {
	const buffer = new KeyBuffer();
	assert.deepEqual(buffer.push("x\x1b["), ["x"]);
	assert.equal(buffer.pending, true);
	assert.deepEqual(buffer.push("A"), ["\x1b[A"]);
});

test("单独一个 ESC：先等着；等不到后续数据，就当作 Esc 键", () => {
	const buffer = new KeyBuffer();
	assert.deepEqual(buffer.push("\x1b"), []);
	assert.deepEqual(buffer.flush(), ["\x1b"]);
});

test("括号粘贴：粘贴的内容整体算一个按键，里面的回车不会被当作提交", () => {
	const buffer = new KeyBuffer();
	const keys = buffer.push("\x1b[200~第一行\r第二行\x1b[201~a");
	assert.equal(keys.length, 2);
	assert.ok(isPaste(keys[0]));
	assert.equal(pasteContent(keys[0]), "第一行\r第二行");
	assert.equal(keys[1], "a");
	// 粘贴的内容分成了好几块送来
	assert.deepEqual(buffer.push("\x1b[200~很长的"), []);
	assert.deepEqual(buffer.push("内容\x1b[201~"), ["\x1b[200~很长的内容\x1b[201~"]);
});

test("哪些是可以输入的字符", () => {
	assert.ok(isPrintable("a"));
	assert.ok(isPrintable("你"));
	assert.ok(!isPrintable("\r"));
	assert.ok(!isPrintable("\x1b[A"));
	assert.ok(!isPrintable("\x03"));
});
