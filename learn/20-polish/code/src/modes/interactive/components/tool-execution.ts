// 一次工具调用：第一行是工具和参数的概要，下面是结果的预览。bash 命令运行时，预览实时更新。
// 对应 pi 的 packages/coding-agent/src/modes/interactive/components/tool-execution.ts，
// 以及 src/core/tools/renderers/（pi 里每个工具自己决定怎么显示）。
import type { AgentToolResult } from "../../../agent/index.ts";
import type { EditToolDetails } from "../../../tools/index.ts";
import { bold, type Component, dim, gray, green, red, stripAnsi, truncateToWidth } from "../../../tui/index.ts";

/** 预览最多显示几行 */
const PREVIEW_LINES = 5;
/** diff 最多显示几行 */
const DIFF_LINES = 20;

/**
 * 去掉命令输出里会弄乱界面的东西：控制序列（颜色、光标移动）、制表符、其他控制字符。
 * 回车符 \r 单独处理：进度条用它回到行首、在原地刷新，所以一行里只保留最后一个 \r 后面的内容。
 */
export function sanitizeOutput(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) =>
			line
				.slice(line.lastIndexOf("\r") + 1)
				.replaceAll("\t", "   ")
				.replace(/[\x00-\x1f\x7f]/g, ""),
		)
		.join("\n");
}

/** 前几行；后面还有的话，加一行说明 */
function firstLines(text: string, count: number): string[] {
	const lines = text === "" ? [] : text.split("\n");
	if (lines.length <= count) return lines;
	return [...lines.slice(0, count), dim(`……（共 ${lines.length} 行）`)];
}

/** 最后几行；前面还有的话，先加一行说明 */
function lastLines(text: string, count: number): string[] {
	const lines = text === "" ? [] : text.split("\n");
	if (lines.length <= count) return lines;
	return [dim(`……（前面还有 ${lines.length - count} 行）`), ...lines.slice(-count)];
}

/** 工具和参数的概要 */
function formatCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return `${bold("$")} ${String(args.command ?? "")}`;
		case "read": {
			const hasRange = args.offset !== undefined || args.limit !== undefined;
			const range = hasRange ? dim(`（从第 ${args.offset ?? 1} 行起，最多 ${args.limit ?? "全部"} 行）`) : "";
			return `${bold("read")} ${String(args.path ?? "")}${range}`;
		}
		case "write":
		case "edit":
			return `${bold(toolName)} ${String(args.path ?? "")}`;
		case "ls":
			return `${bold("ls")} ${String(args.path ?? ".")}`;
		default:
			return `${bold(toolName)} ${dim(JSON.stringify(args))}`;
	}
}

export class ToolExecutionView implements Component {
	private readonly toolName: string;
	private readonly args: Record<string, unknown>;
	private status: "running" | "done" | "error" = "running";
	private output = "";
	private details: unknown;
	/** 内容每变一次加一，用来判断缓存是否还有效 */
	private version = 0;
	private cache: { width: number; version: number; lines: string[] } | undefined;

	constructor(toolName: string, args: Record<string, unknown>) {
		this.toolName = toolName;
		this.args = args;
	}

	/** 工具还在运行时送来的部分结果（比如 bash 到目前为止的输出） */
	setPartialResult(result: AgentToolResult): void {
		this.output = result.content.map((block) => block.text).join("");
		this.version++;
	}

	setResult(result: AgentToolResult, isError: boolean): void {
		this.output = result.content.map((block) => block.text).join("");
		this.details = result.details;
		this.status = isError ? "error" : "done";
		this.version++;
	}

	render(width: number): string[] {
		if (this.cache?.width === width && this.cache.version === this.version) return this.cache.lines;
		const header = formatCall(this.toolName, this.args) + (this.status === "running" ? dim(" 运行中……") : "");
		// 输出的每一行截断而不是折行：预览的高度固定，不会因为一行很长的输出占满屏幕
		const lines = ["", ` ${header}`, ...this.preview().map((line) => gray(" │ ") + line)].map((line) =>
			truncateToWidth(line, width),
		);
		this.cache = { width, version: this.version, lines };
		return lines;
	}

	/** 结果的预览：不同的工具显示不同的东西 */
	private preview(): string[] {
		const output = sanitizeOutput(this.output).trimEnd();
		if (this.status === "error") return firstLines(output, PREVIEW_LINES).map((line) => red(line));
		switch (this.toolName) {
			case "bash":
				// 命令的输出，最后几行最有用（比如测试的结果）
				return lastLines(output, PREVIEW_LINES).map((line) => gray(line));
			case "edit": {
				const diff = (this.details as EditToolDetails | undefined)?.diff ?? "";
				return firstLines(diff, DIFF_LINES).map((line) =>
					line.startsWith("+") ? green(line) : line.startsWith("-") ? red(line) : gray(line),
				);
			}
			case "write":
				return this.status === "done" ? [gray(`已写入 ${String(this.args.content ?? "").split("\n").length} 行`)] : [];
			case "read":
				return firstLines(output, 3).map((line) => gray(line));
			default:
				return firstLines(output, PREVIEW_LINES).map((line) => gray(line));
		}
	}
}
