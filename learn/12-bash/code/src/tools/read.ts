// read 工具：读取文本文件。大文件只返回一部分，并告诉模型怎样继续读。
// 对应 pi 的 packages/coding-agent/src/core/tools/read.ts。
import { readFile } from "node:fs/promises";
import type { AgentTool } from "../agent/index.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { describeFsError, resolvePath, throwIfAborted } from "./util.ts";

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(cwd: string): AgentTool<{ path: string; offset?: number; limit?: number }> {
	return {
		name: "read",
		label: "读取文件",
		description: `读取文本文件的内容。输出最多 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（先达到哪个算哪个）。大文件用 offset 和 limit 分段读取；需要完整内容时，按照提示的 offset 继续读，直到读完。`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径（相对路径或绝对路径）" },
				offset: { type: "integer", description: "从第几行开始读（第一行是 1）" },
				limit: { type: "integer", description: "最多读多少行" },
			},
			required: ["path"],
		},
		async execute(_toolCallId, { path, offset, limit }, signal) {
			throwIfAborted(signal);
			let buffer: Buffer;
			try {
				buffer = await readFile(resolvePath(path, cwd));
			} catch (error) {
				throw new Error(describeFsError(error, path));
			}
			throwIfAborted(signal);

			// 文本文件里不会有值为 0 的字节；有的话，基本可以肯定是二进制文件（图片、压缩包、可执行文件……）
			if (buffer.subarray(0, 8192).includes(0)) {
				throw new Error(`${path} 是二进制文件，无法作为文本读取。`);
			}
			const text = buffer.toString("utf-8");
			if (text === "") return { content: [{ type: "text", text: "（空文件）" }] };

			const allLines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
			const totalLines = allLines.length;
			const start = offset ? Math.max(0, offset - 1) : 0; // offset 从 1 开始，数组下标从 0 开始
			if (start >= totalLines) {
				throw new Error(`offset=${offset} 超出了文件末尾（文件一共 ${totalLines} 行）。`);
			}
			const end = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;
			const truncation = truncateHead(allLines.slice(start, end).join("\n"));

			// 截断时，告诉模型看到了哪些行、怎样继续读。没有这句提示，模型会以为文件就这么长
			const firstShown = start + 1;
			let output: string;
			if (truncation.firstLineExceedsLimit) {
				const size = formatSize(Buffer.byteLength(allLines[start], "utf-8"));
				output = `[第 ${firstShown} 行有 ${size}，超过了 ${formatSize(DEFAULT_MAX_BYTES)} 的上限，无法显示。可以用 bash 查看一部分：sed -n '${firstShown}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const lastShown = firstShown + truncation.outputLines - 1;
				const reason = truncation.truncatedBy === "bytes" ? `（达到了 ${formatSize(DEFAULT_MAX_BYTES)} 的上限）` : "";
				output = `${truncation.content}\n\n[显示了第 ${firstShown}-${lastShown} 行，共 ${totalLines} 行${reason}。用 offset=${lastShown + 1} 继续读取。]`;
			} else if (end < totalLines) {
				output = `${truncation.content}\n\n[文件还有 ${totalLines - end} 行。用 offset=${end + 1} 继续读取。]`;
			} else {
				output = truncation.content;
			}

			const details: ReadToolDetails = truncation.truncated ? { truncation } : {};
			return { content: [{ type: "text", text: output }], details };
		},
	};
}
