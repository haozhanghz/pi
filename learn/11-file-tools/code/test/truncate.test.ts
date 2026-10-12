import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSize, truncateHead } from "../src/tools/index.ts";

const lines = (count: number, make = (i: number) => `第 ${i} 行`) =>
	Array.from({ length: count }, (_, i) => make(i + 1)).join("\n");

test("没有超过上限：原样返回", () => {
	const result = truncateHead("a\nb\nc");
	assert.equal(result.content, "a\nb\nc");
	assert.equal(result.truncated, false);
	assert.equal(result.totalLines, 3);
});

test("末尾的换行不算多出一行", () => {
	assert.equal(truncateHead("a\nb\n").totalLines, 2);
	assert.equal(truncateHead("").totalLines, 0);
});

test("超过行数上限：只保留前面的行", () => {
	const result = truncateHead(lines(10), { maxLines: 3 });
	assert.equal(result.content, "第 1 行\n第 2 行\n第 3 行");
	assert.equal(result.truncatedBy, "lines");
	assert.equal(result.outputLines, 3);
	assert.equal(result.totalLines, 10);
});

test("超过字节上限：按字节计算（一个汉字 3 个字节），只保留完整的行", () => {
	// 每行 "汉字汉字" = 12 字节，加上换行符
	const result = truncateHead(lines(10, () => "汉字汉字"), { maxBytes: 30 });
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "汉字汉字\n汉字汉字", "12 + 1 + 12 = 25 字节，第三行放不下");
	assert.equal(result.outputLines, 2);
});

test("第一行就超过了字节上限", () => {
	const result = truncateHead(`${"x".repeat(100)}\nshort`, { maxBytes: 50 });
	assert.equal(result.firstLineExceedsLimit, true);
	assert.equal(result.content, "");
});

test("formatSize", () => {
	assert.equal(formatSize(512), "512B");
	assert.equal(formatSize(1536), "1.5KB");
	assert.equal(formatSize(2 * 1024 * 1024), "2.0MB");
});
