// 收集命令的输出。
// 问题：命令的输出可能多得没有上限（比如 `yes`，或者一个疯狂打印日志的测试），全部放在内存里会把程序撑爆。
// 解决：内存里只保留最后一部分；输出被截断时，把完整的输出写到临时文件，模型需要时可以去读。
// 对应 pi 的 packages/coding-agent/src/core/tools/output-accumulator.ts。
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncateTail } from "./truncate.ts";

/** 内存里最多保留多少个字符。比截断的上限大一些，保证截断时有足够的内容 */
const KEEP_CHARS = DEFAULT_MAX_BYTES * 2;

export interface CollectedOutput {
	/** 截断后的输出（最后的部分） */
	content: string;
	truncation: TruncationResult;
	/** 完整输出所在的临时文件（只在被截断时才有） */
	fullOutputPath?: string;
}

export class OutputCollector {
	/** 流式解码：一个汉字的 3 个字节可能被分在两块数据里，TextDecoder 会等它凑齐 */
	private readonly decoder = new TextDecoder();
	/** 最后一部分输出 */
	private tail = "";
	/** tail 前面是否丢掉过内容 */
	private droppedFront = false;
	private totalBytes = 0;
	private newlines = 0;
	private lastChar = "";
	/** 还没有临时文件时，原始数据先存在这里 */
	private pending: Buffer[] = [];
	private file: WriteStream | undefined;
	private filePath: string | undefined;

	append(data: Buffer): void {
		this.totalBytes += data.length;
		this.addText(this.decoder.decode(data, { stream: true }));
		if (this.file) {
			this.file.write(data);
		} else {
			this.pending.push(data);
			if (this.totalBytes > DEFAULT_MAX_BYTES) this.openFile(); // 肯定会被截断了，开始写临时文件
		}
	}

	/** 当前的输出（截断后的），用于实时显示进度 */
	snapshot(): CollectedOutput {
		// tail 前面丢过内容的话，第一行可能是半截的，去掉它
		let text = this.tail;
		if (this.droppedFront) {
			const newline = text.indexOf("\n");
			if (newline !== -1) text = text.slice(newline + 1);
		}
		const truncation = truncateTail(text);
		return {
			content: truncation.content,
			// 行数要用整个输出的，而不是 tail 的
			truncation: { ...truncation, truncated: truncation.truncated || this.droppedFront, totalLines: this.totalLines() },
			fullOutputPath: this.filePath,
		};
	}

	/** 命令结束后调用：把剩下的数据解码，被截断时保证完整的输出已经写进临时文件 */
	async finish(): Promise<CollectedOutput> {
		this.addText(this.decoder.decode());
		if (this.snapshot().truncation.truncated && !this.file) this.openFile();
		const file = this.file;
		if (file) await new Promise<void>((resolve) => file.end(resolve));
		return this.snapshot();
	}

	private addText(text: string): void {
		if (text === "") return;
		for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) this.newlines++;
		this.lastChar = text[text.length - 1];
		this.tail += text;
		if (this.tail.length > KEEP_CHARS) {
			this.tail = this.tail.slice(-KEEP_CHARS);
			this.droppedFront = true;
		}
	}

	/** 一共多少行：换行符的个数，加上最后没有换行符结尾的那一行 */
	private totalLines(): number {
		return this.newlines + (this.lastChar !== "" && this.lastChar !== "\n" ? 1 : 0);
	}

	private openFile(): void {
		this.filePath = join(tmpdir(), `mini-pi-bash-${randomBytes(6).toString("hex")}.log`);
		this.file = createWriteStream(this.filePath);
		// 写临时文件失败（比如磁盘满了）不应该让整个程序崩溃：只是没有完整的输出可看了
		this.file.on("error", () => {
			this.filePath = undefined;
		});
		for (const chunk of this.pending) this.file.write(chunk);
		this.pending = [];
	}
}
