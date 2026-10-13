// bash 工具：执行 shell 命令。有了它，agent 就能运行测试、安装依赖、用 git、搜索代码……
// 对应 pi 的 packages/coding-agent/src/core/tools/bash.ts。
import type { AgentTool } from "../agent/index.ts";
import { type CollectedOutput, OutputCollector } from "./output.ts";
import { runCommand } from "./shell.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

/** 实时报告进度的最小间隔 */
const UPDATE_INTERVAL_MS = 100;

export interface BashToolDetails {
	exitCode?: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** 生成给模型看的输出：去掉末尾的换行符，截断时加上说明 */
function formatOutput(output: CollectedOutput): string {
	const { truncation, fullOutputPath } = output;
	const content = output.content.endsWith("\n") ? output.content.slice(0, -1) : output.content;
	if (!truncation.truncated) return content;
	const end = truncation.totalLines;
	const start = end - truncation.outputLines + 1;
	if (truncation.lastLinePartial) {
		return `${content}\n\n[最后一行太长，只显示了它最后的 ${formatSize(DEFAULT_MAX_BYTES)}。完整的输出：${fullOutputPath}]`;
	}
	const reason = truncation.truncatedBy === "bytes" ? `（达到了 ${formatSize(DEFAULT_MAX_BYTES)} 的上限）` : "";
	return `${content}\n\n[显示了第 ${start}-${end} 行，共 ${end} 行${reason}。完整的输出：${fullOutputPath}]`;
}

/** 在输出后面加上状态说明 */
function withStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

export function createBashTool(cwd: string): AgentTool<{ command: string; timeout?: number }> {
	return {
		name: "bash",
		label: "运行命令",
		description: `在当前工作目录执行 bash 命令，返回标准输出和标准错误（合在一起）。输出只保留最后 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（先达到哪个算哪个），被截断时完整的输出会保存到临时文件。可以用 timeout 设置超时（秒），默认不超时。不要运行需要交互输入的命令。`,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的命令" },
				timeout: { type: "number", description: "超时时间（秒），可选" },
			},
			required: ["command"],
		},
		async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
			if (timeout !== undefined && !(timeout > 0)) throw new Error("timeout 必须是大于 0 的秒数。");

			const output = new OutputCollector();
			let lastUpdate = 0;
			const result = await runCommand(command, {
				cwd,
				signal,
				timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
				onData: (data) => {
					output.append(data);
					// 实时报告进度，但最多每 100 毫秒一次，免得界面刷新太频繁
					if (onUpdate && Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
						lastUpdate = Date.now();
						onUpdate({ content: [{ type: "text", text: output.snapshot().content }] });
					}
				},
			});

			const collected = await output.finish();
			const text = formatOutput(collected);
			if (result.aborted) throw new Error(withStatus(text, "命令被取消了。"));
			if (result.timedOut) throw new Error(withStatus(text, `命令超时（${timeout} 秒），已经终止。`));

			const details: BashToolDetails = { exitCode: result.exitCode };
			if (collected.truncation.truncated) {
				details.truncation = collected.truncation;
				details.fullOutputPath = collected.fullOutputPath;
			}
			// 退出码不是 0 表示命令失败了。不抛异常：输出里往往有错误信息，模型需要看到它
			if (result.exitCode !== 0) {
				return { content: [{ type: "text", text: withStatus(text, `命令的退出码是 ${result.exitCode}。`) }], details, isError: true };
			}
			return { content: [{ type: "text", text: text || "（没有输出）" }], details };
		},
	};
}
