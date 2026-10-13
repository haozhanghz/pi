import assert from "node:assert/strict";
import { test } from "node:test";
import { getKeys, matchesAction, normalizeKeyId, setKeybindings } from "../src/tui/keybindings.ts";

test("默认快捷键：一个动作可以有好几个按键", () => {
	assert.ok(matchesAction("\x1b[D", "editor.cursorLeft"), "左方向键");
	assert.ok(matchesAction("\x02", "editor.cursorLeft"), "Ctrl+B");
	assert.ok(!matchesAction("\x1b[C", "editor.cursorLeft"));
	assert.ok(matchesAction("\n", "input.newLine"), "Ctrl+J");
	assert.ok(matchesAction("\x1b\r", "input.newLine"), "Alt+Enter");
	assert.ok(matchesAction("\r", "input.submit"));
});

test("按键名统一成固定的格式", () => {
	assert.equal(normalizeKeyId("Shift+Ctrl+Up"), "ctrl+shift+up");
	assert.equal(normalizeKeyId("ALT+B"), "alt+b");
	assert.equal(normalizeKeyId("PageDown"), "pageDown");
});

test("自定义快捷键：只替换提到的动作，其他保持默认", (t) => {
	t.after(() => setKeybindings({}));
	setKeybindings({ "input.submit": ["Ctrl+S"] });
	assert.ok(matchesAction("\x13", "input.submit"), "Ctrl+S 提交");
	assert.ok(!matchesAction("\r", "input.submit"), "回车不再提交");
	assert.deepEqual(getKeys("input.submit"), ["ctrl+s"]);
	assert.ok(matchesAction("\x1b[D", "editor.cursorLeft"), "别的动作不受影响");
	setKeybindings({});
	assert.ok(matchesAction("\r", "input.submit"), "传入空对象恢复默认");
});
