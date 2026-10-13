import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createLsTool } from "../src/tools/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

test("按字母顺序列出，目录带 /，包括隐藏文件", async (t) => {
	const dir = await makeTempDir(t);
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "README.md"), "");
	await writeFile(join(dir, ".gitignore"), "");
	await writeFile(join(dir, "package.json"), "");
	const result = await createLsTool(dir).execute("id", {});
	assert.equal(result.content[0].text, [".gitignore", "package.json", "README.md", "src/"].join("\n"));
});

test("超过 limit：只列出前面的，并提示一共多少项", async (t) => {
	const dir = await makeTempDir(t);
	for (const name of ["a", "b", "c", "d"]) await writeFile(join(dir, name), "");
	const result = await createLsTool(dir).execute("id", { limit: 2 });
	assert.equal(result.content[0].text, "a\nb\n\n[一共 4 项，只列出了前 2 项。用 limit=4 查看更多。]");
});

test("空目录、不存在的目录、不是目录", async (t) => {
	const dir = await makeTempDir(t);
	const tool = createLsTool(dir);
	await mkdir(join(dir, "empty"));
	assert.equal((await tool.execute("id", { path: "empty" })).content[0].text, "（空目录）");
	await assert.rejects(tool.execute("id", { path: "nope" }), /文件或目录不存在：nope/);
	await writeFile(join(dir, "file.txt"), "");
	await assert.rejects(tool.execute("id", { path: "file.txt" }), /file\.txt 不是一个目录/);
});
