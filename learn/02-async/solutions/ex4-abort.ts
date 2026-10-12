// 练习 4：用 AbortController 取消异步操作（参考答案）
import assert from "node:assert/strict";

/**
 * 可取消的 sleep：
 * - 正常情况下 ms 毫秒后兑现；
 * - 如果 signal 被触发（或者一开始就已经被触发），立刻以 Error("已取消") 拒绝。
 * 注意：被取消时要清理定时器。
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("已取消"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("已取消"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 依次执行 steps 里的步骤（每步是一个"等待若干毫秒"），每完成一步就把步骤名加入结果。
 * 如果中途被取消，停止执行，返回已经完成的步骤名（不抛出异常）。
 */
async function runSteps(steps: { name: string; ms: number }[], signal: AbortSignal): Promise<string[]> {
	const done: string[] = [];
	for (const step of steps) {
		try {
			await abortableSleep(step.ms, signal);
		} catch {
			break;
		}
		done.push(step.name);
	}
	return done;
}

// ----- 检查（不要修改下面的代码） -----
await abortableSleep(20);

const controller = new AbortController();
const start = Date.now();
setTimeout(() => controller.abort(), 50);
await assert.rejects(abortableSleep(1000, controller.signal), /已取消/);
assert.ok(Date.now() - start < 500, "取消之后应该立刻结束，而不是等满 1000ms");

await assert.rejects(abortableSleep(10, AbortSignal.abort()), /已取消/, "已经取消的 signal 应该立刻拒绝");

const c2 = new AbortController();
setTimeout(() => c2.abort(), 130);
const done = await runSteps(
	[
		{ name: "读文件", ms: 50 },
		{ name: "改代码", ms: 50 },
		{ name: "跑测试", ms: 200 },
		{ name: "提交", ms: 50 },
	],
	c2.signal,
);
assert.deepEqual(done, ["读文件", "改代码"]);

// AbortSignal.timeout(ms) 会在 ms 毫秒后自动触发，非常适合做超时
await assert.rejects(abortableSleep(1000, AbortSignal.timeout(30)), /已取消/);
console.log("练习 4 全部通过！");
