import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadContextFiles } from "../src/core/context-files.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

test("全局的在最前面，然后从上层目录到当前目录", async (t) => {
	const root = await makeTempDir(t);
	const agentDir = join(root, "agent");
	const project = join(root, "work", "project");
	const sub = join(project, "packages", "web");
	await mkdir(agentDir, { recursive: true });
	await mkdir(sub, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "全局");
	await writeFile(join(root, "work", "AGENTS.md"), "工作区");
	await writeFile(join(project, "AGENTS.md"), "项目");
	await writeFile(join(sub, "AGENTS.md"), "子目录");

	const files = loadContextFiles(sub, agentDir);
	assert.deepEqual(
		files.map((file) => file.content),
		["全局", "工作区", "项目", "子目录"],
	);
	assert.equal(files[3].path, join(sub, "AGENTS.md"));
});

test("同一个目录里，AGENTS.md 优先于 CLAUDE.md；也认 CLAUDE.md", async (t) => {
	const root = await makeTempDir(t);
	const both = join(root, "both");
	const claude = join(root, "claude");
	await mkdir(both);
	await mkdir(claude);
	await writeFile(join(both, "AGENTS.md"), "agents");
	await writeFile(join(both, "CLAUDE.md"), "claude");
	await writeFile(join(claude, "CLAUDE.md"), "只有 claude");
	assert.deepEqual(
		loadContextFiles(both, join(root, "none")).map((file) => file.content),
		["agents"],
	);
	assert.deepEqual(
		loadContextFiles(claude, join(root, "none")).map((file) => file.content),
		["只有 claude"],
	);
});

test("去掉 BOM；没有说明文件时返回空数组", async (t) => {
	const root = await makeTempDir(t);
	await writeFile(join(root, "AGENTS.md"), "﻿规则");
	assert.equal(loadContextFiles(root, join(root, "none"))[0].content, "规则");
	const empty = join(root, "empty");
	await mkdir(empty);
	// 父目录 root 里有 AGENTS.md，所以从 empty 往上找也能找到它
	assert.equal(loadContextFiles(empty, join(root, "none")).length, 1);
});
