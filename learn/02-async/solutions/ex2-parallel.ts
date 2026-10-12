// 练习 2：串行与并行（参考答案）
import assert from "node:assert/strict";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一个"任务"就是一个返回 Promise 的函数。调用它，任务才开始执行。 */
type Task<T> = () => Promise<T>;

/** 一个接一个地执行，结果按原顺序返回 */
async function runSequential<T>(tasks: Task<T>[]): Promise<T[]> {
	const results: T[] = [];
	for (const task of tasks) {
		results.push(await task());
	}
	return results;
}

/** 同时开始执行，结果仍然按原顺序返回（不是按完成顺序） */
async function runParallel<T>(tasks: Task<T>[]): Promise<T[]> {
	return Promise.all(tasks.map((task) => task()));
}

/**
 * 同时执行，但是有的任务会失败。返回每个任务的结果：
 * 成功是 { ok: true, value }，失败是 { ok: false, error: 错误信息 }。
 * 一个任务失败不能影响其他任务。（里程碑 10 并行执行工具时就需要这样）
 */
async function runParallelSettled<T>(
	tasks: Task<T>[],
): Promise<({ ok: true; value: T } | { ok: false; error: string })[]> {
	return Promise.all(
		tasks.map(async (task) => {
			try {
				return { ok: true as const, value: await task() };
			} catch (error) {
				return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

// ----- 检查（不要修改下面的代码） -----
const finished: string[] = [];
const makeTask = (name: string, ms: number): Task<string> => async () => {
	await sleep(ms);
	finished.push(name);
	return name.toUpperCase();
};

let start = Date.now();
assert.deepEqual(await runSequential([makeTask("a", 100), makeTask("b", 50), makeTask("c", 10)]), ["A", "B", "C"]);
let elapsed = Date.now() - start;
assert.ok(elapsed >= 155, `串行应该至少用 160ms，实际 ${elapsed}ms`);
assert.deepEqual(finished, ["a", "b", "c"]);

finished.length = 0;
start = Date.now();
assert.deepEqual(await runParallel([makeTask("a", 100), makeTask("b", 50), makeTask("c", 10)]), ["A", "B", "C"]);
elapsed = Date.now() - start;
assert.ok(elapsed < 150, `并行应该只用 100ms 左右，实际 ${elapsed}ms`);
assert.deepEqual(finished, ["c", "b", "a"], "并行时，短任务先完成");

const settled = await runParallelSettled<string>([
	makeTask("ok", 10),
	async () => {
		throw new Error("工具执行失败");
	},
	makeTask("also-ok", 20),
]);
assert.deepEqual(settled, [
	{ ok: true, value: "OK" },
	{ ok: false, error: "工具执行失败" },
	{ ok: true, value: "ALSO-OK" },
]);
console.log("练习 2 全部通过！");
