// 练习 1：sleep、重试、超时
// 完成下面三个函数，然后运行：node exercises/ex1-sleep-retry.ts
import assert from "node:assert/strict";

/** 等待 ms 毫秒 */
function sleep(ms: number): Promise<void> {
	// 提示：new Promise((resolve) => setTimeout(resolve, ms))
	throw new Error("TODO：请实现 sleep");
}

/**
 * 反复调用 fn，直到成功或用完 attempts 次机会。每次失败后等待 delayMs 毫秒再试。
 * 成功就返回结果；全部失败就抛出最后一次的错误。
 * （真实的 agent 遇到"服务器太忙（429）"时就是这样重试的，见里程碑 19。）
 */
async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
	// 提示：for 循环 + try { return await fn(); } catch { ... }
	throw new Error("TODO：请实现 retry");
}

/**
 * 给一个 Promise 加上超时：ms 毫秒内没完成，就抛出 Error("超时")。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	// 提示：返回一个 new Promise，在里面同时启动一个 setTimeout 和 promise.then(...)，谁先完成听谁的
	throw new Error("TODO：请实现 withTimeout");
}

// ----- 检查（不要修改下面的代码） -----
let start = Date.now();
await sleep(100);
assert.ok(Date.now() - start >= 95, "sleep(100) 应该至少等待 100 毫秒");

let calls = 0;
const value = await retry(
	async () => {
		calls++;
		if (calls < 3) throw new Error(`第 ${calls} 次失败`);
		return "成功";
	},
	5,
	10,
);
assert.equal(value, "成功");
assert.equal(calls, 3);

calls = 0;
await assert.rejects(
	retry(
		async () => {
			calls++;
			throw new Error(`第 ${calls} 次失败`);
		},
		3,
		10,
	),
	/第 3 次失败/,
);
assert.equal(calls, 3);

assert.equal(await withTimeout(sleep(20).then(() => "快"), 200), "快");
start = Date.now();
await assert.rejects(withTimeout(sleep(500), 50), /超时/);
assert.ok(Date.now() - start < 400, "超时应该在 50 毫秒左右触发，而不是等任务完成");
await assert.rejects(withTimeout(Promise.reject(new Error("原本的错误")), 100), /原本的错误/);
console.log("练习 1 全部通过！");
