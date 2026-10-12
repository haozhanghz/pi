// Promise、async/await、并行与串行。运行：node playground/async-basics.ts

/** 等待 ms 毫秒。返回一个 Promise，ms 毫秒后它会"兑现"。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 模拟一个耗时的工具调用 */
async function fakeTool(name: string, ms: number): Promise<string> {
	await sleep(ms);
	return `${name} 完成（用时 ${ms}ms）`;
}

/** 模拟一个会失败的操作 */
async function flakyRequest(): Promise<string> {
	await sleep(100);
	throw new Error("网络超时");
}

async function main(): Promise<void> {
	// 1. await：等 Promise 兑现，拿到结果
	const result = await fakeTool("read", 300);
	console.log("1.", result);

	// 2. 串行：一个做完再做下一个，总时间是相加
	let start = Date.now();
	await fakeTool("A", 300);
	await fakeTool("B", 300);
	await fakeTool("C", 300);
	console.log(`2. 串行三个任务，用时约 ${Date.now() - start}ms`);

	// 3. 并行：同时开始，一起等，总时间是最长的那个
	start = Date.now();
	const results = await Promise.all([fakeTool("A", 300), fakeTool("B", 300), fakeTool("C", 300)]);
	console.log(`3. 并行三个任务，用时约 ${Date.now() - start}ms`, results);

	// 4. 错误处理：await 一个失败的 Promise 会抛出异常，用 try/catch 接住
	try {
		await flakyRequest();
	} catch (error) {
		console.log("4. 捕获到错误：", error instanceof Error ? error.message : String(error));
	}

	// 5. 忘记 await 会怎样？你得到的是 Promise 本身，而不是结果
	const forgot = fakeTool("忘了 await", 10);
	console.log("5. 没有 await 时拿到的是：", forgot);
	await forgot;
}

await main();
console.log("全部结束");
