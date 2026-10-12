// edit 工具：用"精确的文字替换"修改文件的一部分。
// 模型给出 oldText（文件里原来的一段文字）和 newText（换成什么），我们找到 oldText，换成 newText。
// 对应 pi 的 packages/coding-agent/src/core/tools/edit.ts 和 edit-diff.ts。
import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "../agent/index.ts";
import { diffLines, formatDiff } from "./diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { describeFsError, resolvePath, throwIfAborted } from "./util.ts";

export interface Edit {
	oldText: string;
	newText: string;
}

export interface EditToolDetails {
	/** 给人看的 diff */
	diff: string;
	/** 第一处改动在新文件里的行号 */
	firstChangedLine?: number;
}

/** 文件用的是哪种换行符：Windows 上常见 \r\n，其他系统是 \n。以第一个换行符为准 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const lf = content.indexOf("\n");
	return lf > 0 && content[lf - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** text 在 content 里出现了几次（包括互相重叠的情况） */
function countOccurrences(content: string, text: string): number {
	let count = 0;
	for (let index = content.indexOf(text); index !== -1; index = content.indexOf(text, index + 1)) count++;
	return count;
}

/**
 * 把多处替换应用到内容上，返回新内容。有任何问题都抛出异常（错误信息是写给模型看的）。
 *
 * 所有 oldText 都在**原来的**内容里查找，而不是一处一处依次应用：模型是根据它读到的原文件写出这些 oldText 的。
 * 所以要求每个 oldText 在原文件里唯一，并且互相不重叠。
 */
export function applyEdits(content: string, edits: Edit[], path: string): string {
	const label = (index: number) => (edits.length === 1 ? "oldText" : `edits[${index}].oldText`);
	const matches = edits.map((edit, index) => {
		if (edit.oldText === "") throw new Error(`${label(index)} 不能为空。`);
		const start = content.indexOf(edit.oldText);
		if (start === -1) {
			throw new Error(`在 ${path} 里找不到 ${label(index)}。它必须和文件内容完全一致，包括空格、缩进和换行。`);
		}
		const count = countOccurrences(content, edit.oldText);
		if (count > 1) {
			throw new Error(`${label(index)} 在 ${path} 里出现了 ${count} 次，必须是唯一的。请多包含一些上下文，让它只匹配一处。`);
		}
		return { index, start, end: start + edit.oldText.length, newText: edit.newText };
	});

	// 按位置排序，检查相邻的两处有没有重叠
	matches.sort((x, y) => x.start - y.start);
	for (let k = 1; k < matches.length; k++) {
		if (matches[k - 1].end > matches[k].start) {
			throw new Error(
				`edits[${matches[k - 1].index}] 和 edits[${matches[k].index}] 在 ${path} 里有重叠。请把它们合并成一处，或者只替换不重叠的部分。`,
			);
		}
	}

	// 从后往前替换：替换后面的内容，不会影响前面各处的位置
	let result = content;
	for (const match of matches.toReversed()) {
		result = result.slice(0, match.start) + match.newText + result.slice(match.end);
	}
	if (result === content) throw new Error(`没有修改 ${path}：替换之后的内容和原来完全一样。`);
	return result;
}

export function createEditTool(cwd: string): AgentTool<{ path: string; edits: Edit[] }> {
	return {
		name: "edit",
		label: "修改文件",
		description:
			"用精确的文字替换修改一个文件。每个 edits[].oldText 必须和原文件里的一段文字完全一致（包括空格、缩进和换行），在文件里只出现一次，并且和其他 oldText 不重叠。所有 oldText 都在原文件里查找，而不是依次应用。两处修改离得很近时，把它们合并成一处。oldText 在保证唯一的前提下越短越好，不要为了连接两处修改而包含大段没有改动的内容。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径（相对路径或绝对路径）" },
				edits: {
					type: "array",
					description: "一处或多处替换",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", description: "原文件里要被替换的文字，必须唯一" },
							newText: { type: "string", description: "替换成的新文字" },
						},
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
		async execute(_toolCallId, { path, edits }, signal) {
			if (edits.length === 0) throw new Error("edits 不能为空，至少要有一处替换。");
			const absolutePath = resolvePath(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				let raw: string;
				try {
					raw = await readFile(absolutePath, "utf-8");
				} catch (error) {
					throw new Error(`无法修改 ${path}：${describeFsError(error, path)}`);
				}
				throwIfAborted(signal);

				// 模型看不见文件开头的 BOM（一个不可见的字符），也不会在 oldText 里写 \r\n。
				// 所以先去掉 BOM、统一成 \n，替换完再还原，保持文件原来的格式
				const bom = raw.startsWith("﻿") ? "﻿" : "";
				const content = normalizeToLF(raw.slice(bom.length));
				const lineEnding = detectLineEnding(raw);
				const normalizedEdits = edits.map((edit) => ({
					oldText: normalizeToLF(edit.oldText),
					newText: normalizeToLF(edit.newText),
				}));
				const updated = applyEdits(content, normalizedEdits, path);

				await writeFile(absolutePath, bom + restoreLineEndings(updated, lineEnding), "utf-8");
				throwIfAborted(signal);

				const { diff, firstChangedLine } = formatDiff(diffLines(content, updated));
				const details: EditToolDetails = { diff, firstChangedLine };
				return { content: [{ type: "text", text: `已修改 ${path}：替换了 ${edits.length} 处。` }], details };
			});
		},
	};
}
