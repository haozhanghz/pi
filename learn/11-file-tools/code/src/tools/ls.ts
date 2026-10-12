// ls 工具：列出目录的内容。
// 对应 pi 的 packages/coding-agent/src/core/tools/ls.ts。
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import type { AgentTool } from "../agent/index.ts";
import { describeFsError, resolvePath, throwIfAborted } from "./util.ts";

const DEFAULT_LIMIT = 500;

export function createLsTool(cwd: string): AgentTool<{ path?: string; limit?: number }> {
	return {
		name: "ls",
		label: "列出目录",
		description: `列出目录的内容。按字母顺序排列，目录名后面带 /，包括隐藏文件（以 . 开头的文件）。最多列出 ${DEFAULT_LIMIT} 项。`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "要列出的目录（默认是当前目录）" },
				limit: { type: "integer", description: `最多列出多少项（默认 ${DEFAULT_LIMIT}）` },
			},
		},
		async execute(_toolCallId, { path = ".", limit = DEFAULT_LIMIT }, signal) {
			throwIfAborted(signal);
			let entries: Dirent[];
			try {
				entries = await readdir(resolvePath(path, cwd), { withFileTypes: true });
			} catch (error) {
				throw new Error(describeFsError(error, path));
			}

			const names = entries
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			if (names.length === 0) return { content: [{ type: "text", text: "（空目录）" }] };

			let output = names.slice(0, limit).join("\n");
			if (names.length > limit) {
				output += `\n\n[一共 ${names.length} 项，只列出了前 ${limit} 项。用 limit=${limit * 2} 查看更多。]`;
			}
			return { content: [{ type: "text", text: output }] };
		},
	};
}
