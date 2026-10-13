import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { OutputCollector } from "../src/tools/index.ts";

test("少量输出：原样保留，不写临时文件", async () => {
	const output = new OutputCollector();
	output.append(Buffer.from("hello\n"));
	output.append(Buffer.from("world\n"));
	const result = await output.finish();
	assert.equal(result.content, "hello\nworld\n");
	assert.equal(result.truncation.truncated, false);
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.fullOutputPath, undefined);
});

test("一个汉字被分在两块数据里：也能正确解码", async () => {
	const bytes = Buffer.from("你好");
	const output = new OutputCollector();
	output.append(bytes.subarray(0, 2)); // "你" 的前两个字节
	output.append(bytes.subarray(2)); // "你" 的最后一个字节和 "好"
	assert.equal((await output.finish()).content, "你好");
});

test("输出很多：只保留最后的部分，完整的输出写进临时文件", async (t) => {
	const output = new OutputCollector();
	const all = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1}`).join("\n");
	// 一块一块地送进去，像真实的命令那样
	for (let i = 0; i < all.length; i += 4096) output.append(Buffer.from(all.slice(i, i + 4096)));
	const result = await output.finish();
	if (result.fullOutputPath) {
		const path = result.fullOutputPath;
		t.after(() => rm(path, { force: true }));
	}

	assert.equal(result.truncation.truncated, true);
	assert.equal(result.truncation.totalLines, 50_000, "总行数是整个输出的，而不是内存里那部分的");
	assert.ok(result.content.endsWith("line 50000"));
	assert.equal(result.content.split("\n").length, 2000);
	assert.ok(result.fullOutputPath);
	assert.equal(await readFile(result.fullOutputPath, "utf-8"), all, "临时文件里是完整的输出");
});

test("按行数截断（总字节不多）时，也会写临时文件", async (t) => {
	const output = new OutputCollector();
	output.append(Buffer.from(Array.from({ length: 3000 }, (_, i) => String(i)).join("\n")));
	const result = await output.finish();
	assert.ok(result.fullOutputPath);
	const path = result.fullOutputPath;
	t.after(() => rm(path, { force: true }));
	assert.equal(result.truncation.truncatedBy, "lines");
	assert.equal((await readFile(path, "utf-8")).split("\n").length, 3000);
});
