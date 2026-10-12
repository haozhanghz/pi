// 打字机：用"异步生成器"模拟大模型的流式输出，并支持按 Ctrl+C 中途停止。
// 运行：node playground/typewriter.ts
// 输出过程中按 Ctrl+C，程序不会直接崩溃退出，而是优雅地停下并打印统计。

const story =
	"从前有一个程序员，他想写一个 coding agent。" +
	"他先学会了和大模型说话，又学会了让模型调用工具，" +
	"最后，他的 agent 能够自己读代码、改代码、跑测试。" +
	"这个故事告诉我们：复杂的东西，都是由简单的部分一点点搭起来的。";

/**
 * 可以被取消的 sleep：时间到了就兑现；如果中途 signal 被触发，也立刻兑现。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * 生产者：把文字切成 1~3 个字的小块，每隔一小会儿"吐出"一块。
 * 它只负责"产生数据"，完全不关心数据会被打印、保存还是丢掉。
 */
async function* fakeStream(text: string, signal?: AbortSignal): AsyncGenerator<string> {
	const chars = Array.from(text); // 按字符拆开（直接用 text[i] 遇到 emoji 等字符会出错）
	let i = 0;
	while (i < chars.length) {
		if (signal?.aborted) return; // 被取消了：结束生成器，for await 循环会随之结束
		const size = 1 + Math.floor(Math.random() * 3);
		yield chars.slice(i, i + size).join("");
		i += size;
		await sleep(30 + Math.random() * 70, signal);
	}
}

/**
 * 消费者：一块一块地拿到数据，立即打印。
 */
async function main(): Promise<void> {
	const controller = new AbortController();
	// 用户按 Ctrl+C 时，系统会给程序发送 SIGINT 信号。我们接住它，触发取消。
	process.on("SIGINT", () => controller.abort());

	const start = Date.now();
	let received = 0;
	for await (const chunk of fakeStream(story, controller.signal)) {
		process.stdout.write(chunk); // 和 console.log 不同，write 不会自动换行
		received += Array.from(chunk).length;
	}
	process.stdout.write("\n");

	const status = controller.signal.aborted ? "被你中断了" : "完整输出";
	console.log(`（${status}：共 ${received} 个字，用时 ${Date.now() - start}ms）`);
}

await main();
