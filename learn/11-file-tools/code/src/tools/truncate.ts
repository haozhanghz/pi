// 截断工具的输出。模型的上下文窗口有限，而且按 token 收费：一个 10MB 的日志文件不能整个塞给模型。
// 两个上限，先达到哪个算哪个：最多 2000 行、最多 50KB。
// 对应 pi 的 packages/coding-agent/src/core/tools/truncate.ts。

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 因为哪个上限被截断 */
	truncatedBy: "lines" | "bytes" | null;
	/** 原来一共多少行 */
	totalLines: number;
	/** 截断后保留了多少行 */
	outputLines: number;
	/** 第一行本身就超过了字节上限（比如压缩过的 JS 文件，整个文件只有一行） */
	firstLineExceedsLimit: boolean;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

/** 把字节数显示成容易读的形式：512B、1.5KB、2.0MB */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 按行切开，用于计数：末尾的换行不算多出一行 */
function splitLines(content: string): string[] {
	if (content === "") return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * 保留开头的部分（读文件时用：从头开始看）。
 * 只保留完整的行，绝不把一行从中间切断。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const lines = splitLines(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && Buffer.byteLength(content, "utf-8") <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, firstLineExceedsLimit: false };
	}

	const output: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (const line of lines) {
		if (output.length >= maxLines) break;
		// 注意要用字节数，而不是字符数：一个汉字占 3 个字节
		const lineBytes = Buffer.byteLength(line, "utf-8") + (output.length > 0 ? 1 : 0); // +1 是换行符
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		output.push(line);
		bytes += lineBytes;
	}

	return {
		content: output.join("\n"),
		truncated: true,
		truncatedBy,
		totalLines,
		outputLines: output.length,
		firstLineExceedsLimit: truncatedBy === "bytes" && output.length === 0,
	};
}
