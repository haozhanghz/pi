// print 模式：发送消息，输出结果，退出。适合在脚本里使用。
// 对应 pi 的 packages/coding-agent/src/modes/print-mode.ts。
import type { Agent } from "../agent/index.ts";

export interface PrintModeOptions {
	/** text：只输出最终回答；json：每行输出一个事件（给其他程序读取） */
	mode: "text" | "json";
	/** 依次发送的消息 */
	messages: string[];
}

/** 运行 print 模式，返回程序的退出码 */
export async function runPrintMode(agent: Agent, options: PrintModeOptions): Promise<number> {
	if (options.mode === "json") {
		agent.subscribe((event) => {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		});
	}

	for (const message of options.messages) {
		await agent.prompt(message);
	}

	const last = agent.state.messages.at(-1);
	if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
		// 错误信息写到标准错误，退出码 1：调用这个程序的脚本能知道出错了
		console.error(last.errorMessage ?? `请求失败（${last.stopReason}）`);
		return 1;
	}
	if (options.mode === "text" && last?.role === "assistant") {
		const text = last.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		process.stdout.write(`${text}\n`);
	}
	return 0;
}
