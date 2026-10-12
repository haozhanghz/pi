import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, createEditTool, type EditToolDetails } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const code = `function add(a, b) {
	return a + b;
}

function sub(a, b) {
	return a - b;
}
`;

test("替换一处：文件被修改，details 里有 diff", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "math.js"), code);
	const result = await createEditTool(dir).execute("id", {
		path: "math.js",
		edits: [{ oldText: "return a + b;", newText: "return a + b + 0;" }],
	});
	assert.equal(result.content[0].text, "已修改 math.js：替换了 1 处。");
	assert.equal(await readFile(join(dir, "math.js"), "utf-8"), code.replace("return a + b;", "return a + b + 0;"));
	const details = result.details as EditToolDetails;
	assert.match(details.diff, /^-2 \treturn a \+ b;$/m);
	assert.match(details.diff, /^\+2 \treturn a \+ b \+ 0;$/m);
	assert.equal(details.firstChangedLine, 2);
});

test("一次替换多处：都和原文件比对", () => {
	const result = applyEdits(
		code,
		[
			{ oldText: "function add", newText: "function plus" },
			{ oldText: "function sub", newText: "function minus" },
		],
		"math.js",
	);
	assert.ok(result.includes("function plus(a, b)"));
	assert.ok(result.includes("function minus(a, b)"));
});

test("找不到 oldText：报错，文件不变", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "math.js"), code);
	await assert.rejects(
		createEditTool(dir).execute("id", { path: "math.js", edits: [{ oldText: "return a * b;", newText: "x" }] }),
		/在 math\.js 里找不到 oldText。它必须和文件内容完全一致/,
	);
	assert.equal(await readFile(join(dir, "math.js"), "utf-8"), code);
});

test("oldText 不唯一：报错，并说出现了几次", () => {
	assert.throws(() => applyEdits(code, [{ oldText: "(a, b)", newText: "(x, y)" }], "math.js"), /出现了 2 次，必须是唯一的/);
});

test("多处替换互相重叠：报错", () => {
	assert.throws(
		() =>
			applyEdits(
				code,
				[
					{ oldText: "function add(a, b)", newText: "x" },
					{ oldText: "add(a, b) {", newText: "y" },
				],
				"math.js",
			),
		/edits\[0\] 和 edits\[1\] 在 math\.js 里有重叠/,
	);
});

test("oldText 为空、替换前后没有变化：报错", () => {
	assert.throws(() => applyEdits(code, [{ oldText: "", newText: "x" }], "math.js"), /oldText 不能为空/);
	assert.throws(
		() => applyEdits(code, [{ oldText: "return a + b;", newText: "return a + b;" }], "math.js"),
		/替换之后的内容和原来完全一样/,
	);
});

test("Windows 换行符（\\r\\n）：模型写的 \\n 也能匹配，修改后仍然是 \\r\\n", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "win.txt"), "第一行\r\n第二行\r\n第三行\r\n");
	await createEditTool(dir).execute("id", {
		path: "win.txt",
		edits: [{ oldText: "第一行\n第二行", newText: "第 1 行\n第 2 行" }],
	});
	assert.equal(await readFile(join(dir, "win.txt"), "utf-8"), "第 1 行\r\n第 2 行\r\n第三行\r\n");
});

test("文件开头的 BOM 被保留", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "bom.txt"), "﻿hello world");
	await createEditTool(dir).execute("id", { path: "bom.txt", edits: [{ oldText: "hello", newText: "你好" }] });
	assert.equal(await readFile(join(dir, "bom.txt"), "utf-8"), "﻿你好 world");
});

test("同时修改同一个文件的两处（并行执行的两次 edit）：两处修改都保留", async (t) => {
	const dir = await makeTempDir(t);
	await writeFile(join(dir, "math.js"), code);
	const tool = createEditTool(dir);
	await Promise.all([
		tool.execute("1", { path: "math.js", edits: [{ oldText: "function add", newText: "function plus" }] }),
		tool.execute("2", { path: "math.js", edits: [{ oldText: "function sub", newText: "function minus" }] }),
	]);
	const content = await readFile(join(dir, "math.js"), "utf-8");
	assert.ok(content.includes("function plus"), "第一处修改没有丢");
	assert.ok(content.includes("function minus"));
});

test("文件不存在：报错", async (t) => {
	const dir = await makeTempDir(t);
	await assert.rejects(
		createEditTool(dir).execute("id", { path: "nope.js", edits: [{ oldText: "a", newText: "b" }] }),
		/无法修改 nope\.js：文件或目录不存在/,
	);
});
