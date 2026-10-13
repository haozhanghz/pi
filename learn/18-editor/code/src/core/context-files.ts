// 加载项目的说明文件（AGENTS.md）。
// 每个项目都有自己的规矩：用什么命令跑测试、代码风格、哪些文件不能动……
// 把它们写在项目里的 AGENTS.md，agent 启动时读进系统提示词，就不用每次都告诉它了。
// 对应 pi 的 packages/coding-agent/src/core/resource-loader.ts（loadProjectContextFiles）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

/** 每个目录里按这个顺序找，找到一个就停 */
const CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

function loadFromDir(dir: string): ContextFile | undefined {
	for (const name of CANDIDATES) {
		const path = join(dir, name);
		if (existsSync(path) && statSync(path).isFile()) {
			const content = readFileSync(path, "utf-8");
			return { path, content: content.startsWith("﻿") ? content.slice(1) : content };
		}
	}
	return undefined;
}

/**
 * 依次加载：
 *   1. 全局的说明文件：~/.mini-pi/AGENTS.md（对所有项目都有效的个人习惯）
 *   2. 从根目录到当前目录，每一层目录的说明文件（越靠近当前目录的越具体，放在越后面）
 */
export function loadContextFiles(cwd: string, agentDir: string): ContextFile[] {
	const files: ContextFile[] = [];
	const global = loadFromDir(agentDir);
	if (global) files.push(global);

	const ancestors: ContextFile[] = [];
	let dir = resolve(cwd);
	while (true) {
		const file = loadFromDir(dir);
		if (file && file.path !== global?.path) ancestors.unshift(file); // 加在前面：根目录的排在最前
		const parent = dirname(dir);
		if (parent === dir) break; // 到根目录了
		dir = parent;
	}
	return [...files, ...ancestors];
}
