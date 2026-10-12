import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createReadTool } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

async function read(cwd: string, args: { path: string; offset?: number; limit?: number }): Promise<string> {
	const result = await createReadTool(cwd).execute("id", args);
	return result.content[0].text;
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

test("读取小文件：返回全部内容", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "a.txt"), "你好\n世界\n");
	assert.equal(await read(dir, { path: "a.txt" }), "你好\n世界");
});

test("相对路径相对于 cwd；去掉开头的 @", async (t) => {
	const dir = await makeTempDir(t);
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "src", "main.ts"), "main");
	assert.equal(await read(dir, { path: "src/main.ts" }), "main");
	assert.equal(await read(dir, { path: "@src/main.ts" }), "main");
	assert.equal(await read(dir, { path: join(dir, "src", "main.ts") }), "main", "绝对路径也可以");
});

test("offset 和 limit：读取一部分，并提示还有多少行", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "a.txt"), numbered(10));
	const text = await read(dir, { path: "a.txt", offset: 3, limit: 2 });
	assert.equal(text, "line 3\nline 4\n\n[文件还有 6 行。用 offset=5 继续读取。]");
	assert.equal(await read(dir, { path: "a.txt", offset: 9 }), "line 9\nline 10");
});

test("超过 2000 行：截断，并告诉模型怎样继续读", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "big.txt"), numbered(2500));
	const text = await read(dir, { path: "big.txt" });
	assert.ok(text.startsWith("line 1\n"));
	assert.ok(text.includes("line 2000\n"));
	assert.ok(!text.includes("line 2001"));
	assert.ok(text.endsWith("[显示了第 1-2000 行，共 2500 行。用 offset=2001 继续读取。]"));
	// 按照提示继续读
	const rest = await read(dir, { path: "big.txt", offset: 2001 });
	assert.ok(rest.startsWith("line 2001\n"));
	assert.ok(rest.endsWith("line 2500"));
});

test("超过 50KB：按字节截断", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "wide.txt"), Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
	const text = await read(dir, { path: "wide.txt" });
	assert.match(text, /\[显示了第 1-51 行，共 100 行（达到了 50\.0KB 的上限）。用 offset=52 继续读取。\]$/);
});

test("出错的情况：文件不存在、是目录、是二进制文件、offset 超出范围", async (t) => {
	const dir = await makeTempDir(t);
	const tool = createReadTool(dir);
	await assert.rejects(tool.execute("id", { path: "nope.txt" }), /文件或目录不存在：nope\.txt/);
	await mkdir(join(dir, "src"));
	await assert.rejects(tool.execute("id", { path: "src" }), /是一个目录.*ls/);
	await writeFile(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
	await assert.rejects(tool.execute("id", { path: "image.png" }), /二进制文件/);
	await writeFile(join(dir, "a.txt"), "one\ntwo");
	await assert.rejects(tool.execute("id", { path: "a.txt", offset: 5 }), /超出了文件末尾（文件一共 2 行）/);
});

test("空文件", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "empty.txt"), "");
	assert.equal(await read(dir, { path: "empty.txt" }), "（空文件）");
});
