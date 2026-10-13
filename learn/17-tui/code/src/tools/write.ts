// write 工具：创建新文件，或者完全重写一个文件。
// 对应 pi 的 packages/coding-agent/src/core/tools/write.ts。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "../agent/index.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { describeFsError, resolvePath, throwIfAborted } from "./util.ts";

export function createWriteTool(cwd: string): AgentTool<{ path: string; content: string }> {
	return {
		name: "write",
		label: "写入文件",
		description:
			"把内容写入文件：文件不存在时创建，存在时覆盖。会自动创建需要的父目录。只用于创建新文件或者完全重写；修改文件的一部分请用 edit。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径（相对路径或绝对路径）" },
				content: { type: "string", description: "要写入的完整内容" },
			},
			required: ["path", "content"],
		},
		async execute(_toolCallId, { path, content }, signal) {
			const absolutePath = resolvePath(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// 注意：这里不在 abort 事件里直接抛出异常，而是在每一步之后检查。
				// 否则文件还在写，队列就已经放下一个操作进来了
				throwIfAborted(signal);
				try {
					await mkdir(dirname(absolutePath), { recursive: true }); // 相当于 mkdir -p
					await writeFile(absolutePath, content, "utf-8");
				} catch (error) {
					throw new Error(`无法写入 ${path}：${describeFsError(error, path)}`);
				}
				throwIfAborted(signal);
				return { content: [{ type: "text", text: `已写入 ${path}` }] };
			});
		},
	};
}
