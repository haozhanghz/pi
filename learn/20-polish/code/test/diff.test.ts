import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, formatDiff } from "../src/tools/index.ts";

const summary = (oldText: string, newText: string) =>
	diffLines(oldText, newText).map((line) => `${line.type[0]}:${line.text}`);

test("内容相同：每一行都是 same", () => {
	assert.deepEqual(summary("a\nb", "a\nb"), ["s:a", "s:b"]);
});

test("修改一行", () => {
	assert.deepEqual(summary("a\nb\nc", "a\nB\nc"), ["s:a", "r:b", "a:B", "s:c"]);
});

test("在中间插入、在末尾删除", () => {
	assert.deepEqual(summary("a\nc\nd", "a\nb\nc"), ["s:a", "a:b", "s:c", "r:d"]);
});

test("行号：删除的行用旧行号，新增的行用新行号", () => {
	const lines = diffLines("a\nb\nc", "a\nx\ny\nc");
	assert.deepEqual(
		lines.map((line) => [line.type, line.oldLine, line.newLine]),
		[
			["same", 1, 1],
			["removed", 2, undefined],
			["added", undefined, 2],
			["added", undefined, 3],
			["same", 3, 4],
		],
	);
});

test("formatDiff：只显示改动附近的行，其余用 ... 代替", () => {
	const oldText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const newText = oldText.replace("line 10", "LINE 10");
	const { diff, firstChangedLine } = formatDiff(diffLines(oldText, newText), 2);
	assert.equal(firstChangedLine, 10);
	assert.deepEqual(diff.split("\n"), [
		"    ...",
		"  8 line 8",
		"  9 line 9",
		"-10 line 10",
		"+10 LINE 10",
		" 11 line 11",
		" 12 line 12",
		"    ...",
	]);
});

test("formatDiff：只删除时，firstChangedLine 是删除的位置", () => {
	const { firstChangedLine } = formatDiff(diffLines("a\nb\nc", "a\nc"));
	assert.equal(firstChangedLine, 2);
});
