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
	/** 第一行本身就超过了字节上限（比如压缩过的 JS 文件，整个文件只有一行）。只有 truncateHead 会设置 */
	firstLineExceedsLimit: boolean;
	/** 最后一行本身就超过了字节上限，只保留了它的结尾部分。只有 truncateTail 会设置 */
	lastLinePartial: boolean;
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
		return notTruncated(content, totalLines);
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
		lastLinePartial: false,
	};
}

/**
 * 保留结尾的部分（命令的输出用：错误信息和最终结果通常在最后）。
 * 只保留完整的行；唯一的例外是最后一行本身就超过了字节上限，这时保留它的结尾部分。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const lines = splitLines(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && Buffer.byteLength(content, "utf-8") <= maxBytes) {
		return notTruncated(content, totalLines);
	}

	// 从最后一行往前收集
	const output: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let i = lines.length - 1; i >= 0 && output.length < maxLines; i--) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (output.length > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (output.length === 0) {
				output.push(lastBytes(lines[i], maxBytes));
				lastLinePartial = true;
			}
			break;
		}
		output.push(lines[i]);
		bytes += lineBytes;
	}
	output.reverse();

	return {
		content: output.join("\n"),
		truncated: true,
		truncatedBy,
		totalLines,
		outputLines: output.length,
		firstLineExceedsLimit: false,
		lastLinePartial,
	};
}

/** 取一段文字最后的 maxBytes 个字节，不切断任何一个字符 */
function lastBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	let start = buffer.length - maxBytes;
	// UTF-8 里，一个字符的第 2、3、4 个字节都以二进制 10 开头。从这样的字节开始会切断字符，所以往后挪到下一个字符的开头
	while (start < buffer.length && (buffer[start] & 0b11000000) === 0b10000000) start++;
	return buffer.subarray(start).toString("utf-8");
}

function notTruncated(content: string, totalLines: number): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		outputLines: totalLines,
		firstLineExceedsLimit: false,
		lastLinePartial: false,
	};
}
