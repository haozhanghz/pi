import assert from "node:assert/strict";
import { test } from "node:test";
import { bold, green, red, stripAnsi, truncateToWidth, visibleWidth, wrapText } from "../src/tui/index.ts";

test("宽度：英文 1 列，汉字和全角标点 2 列，emoji 2 列，控制序列 0 列", () => {
	assert.equal(visibleWidth("hello"), 5);
	assert.equal(visibleWidth("你好"), 4);
	assert.equal(visibleWidth("你好，世界！"), 12, "全角的逗号和感叹号也占 2 列");
	assert.equal(visibleWidth("こんにちは"), 10);
	assert.equal(visibleWidth("👍"), 2);
	assert.equal(visibleWidth("👨‍👩‍👧"), 2, "由好几个码点组成的家庭 emoji 也只占 2 列");
	assert.equal(visibleWidth(red("错误")), 4, "颜色不占位置");
	assert.equal(visibleWidth("é"), 1, "字母加上组合的声调符号，只占 1 列");
});

test("去掉控制序列", () => {
	assert.equal(stripAnsi(bold(red("重要"))), "重要");
});

test("截断：超出时加省略号，不把汉字切成两半", () => {
	assert.equal(truncateToWidth("hello world", 8), "hello w…");
	assert.equal(truncateToWidth("你好世界", 5), "你好…", "第三个字放不下（需要 2 列，只剩 1 列）");
	assert.equal(truncateToWidth("短", 10), "短", "没有超出就原样返回");
});

test("截断带颜色的文字：保留控制序列，最后加 RESET", () => {
	const result = truncateToWidth(red("abcdefgh"), 5);
	assert.equal(stripAnsi(result), "abcd…");
	assert.ok(result.startsWith("\x1b[31m"));
	assert.ok(result.includes("\x1b[0m"), "防止红色漏到后面");
});

test("换行：英文在空格处换行，不拆开单词", () => {
	assert.deepEqual(wrapText("the quick brown fox", 10), ["the quick", "brown fox"]);
	assert.deepEqual(wrapText("supercalifragilistic", 8), ["supercal", "ifragili", "stic"], "单词比一行还宽时只能拆开");
});

test("换行：汉字可以在任意两个字之间换行，按宽度计算", () => {
	assert.deepEqual(wrapText("一二三四五六七", 6), ["一二三", "四五六", "七"]);
	assert.deepEqual(wrapText("用 npm test 运行测试", 10), ["用 npm", "test 运行", "测试"]);
});

test("换行：保留原来的换行符", () => {
	assert.deepEqual(wrapText("第一行\n\n第三行", 20), ["第一行", "", "第三行"]);
});

test("换行：带颜色的文字，每一行都独立地打开和关闭样式", () => {
	const lines = wrapText(red("红色的很长很长的文字"), 8);
	assert.equal(lines.length, 3);
	for (const line of lines) {
		assert.ok(line.startsWith("\x1b[31m"), `每一行都以红色开始：${JSON.stringify(line)}`);
	}
	assert.ok(lines[0].endsWith("\x1b[0m"), "换行的地方关闭样式");
	assert.deepEqual(lines.map(stripAnsi), ["红色的很", "长很长的", "文字"]);
});

test("换行：样式跨越换行符时，下一行开头重新打开", () => {
	const lines = wrapText(bold("第一行\n第二行"), 20);
	assert.deepEqual(lines.map(stripAnsi), ["第一行", "第二行"]);
	assert.ok(lines[0].endsWith("\x1b[0m"));
	assert.ok(lines[1].startsWith("\x1b[1m第二行"), JSON.stringify(lines[1]));
});

test("换行：只重新打开最后还开着的样式，关闭过的不会越积越多", () => {
	const lines = wrapText(`${red("红")}${green("绿")}${red("很长很长的红色文字")}`, 6);
	assert.deepEqual(lines.map(stripAnsi), ["红绿很", "长很长", "的红色", "文字"]);
	assert.ok(lines[1].startsWith("\x1b[31m长"), JSON.stringify(lines[1]));
});
