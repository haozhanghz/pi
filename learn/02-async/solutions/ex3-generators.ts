// 练习 3：异步生成器（参考答案）
import assert from "node:assert/strict";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 倒数：依次产生 n, n-1, ..., 1，每两个数之间等待 ms 毫秒 */
async function* countdown(n: number, ms: number): AsyncGenerator<number> {
	for (let i = n; i >= 1; i--) {
		yield i;
		if (i > 1) await sleep(ms);
	}
}

/** 把一个异步可迭代对象的所有元素收集成数组 */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of source) items.push(item);
	return items;
}

/** 只取前 n 个元素；取够了就停止（不再读取后面的元素） */
async function* take<T>(source: AsyncIterable<T>, n: number): AsyncGenerator<T> {
	if (n <= 0) return;
	let count = 0;
	for await (const item of source) {
		yield item;
		count++;
		if (count >= n) return;
	}
}

/**
 * 输入是一个个"文字片段"（就像流式输出收到的那样，片段可能在任意位置切开），
 * 输出是一行一行完整的文字。最后剩下的、没有换行符结尾的部分也要输出（如果不为空）。
 * 这正是里程碑 05 解析流式响应时要做的事情。
 */
async function* lines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
	let buffer = "";
	for await (const chunk of chunks) {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index !== -1) {
			yield buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) yield buffer;
}

// ----- 检查（不要修改下面的代码） -----
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
	for (const item of items) {
		await sleep(1);
		yield item;
	}
}

const start = Date.now();
assert.deepEqual(await collect(countdown(3, 50)), [3, 2, 1]);
assert.ok(Date.now() - start >= 95, "3,2,1 之间应该有两次 50ms 的等待");

assert.deepEqual(await collect(take(fromArray(["a", "b", "c", "d"]), 2)), ["a", "b"]);
assert.deepEqual(await collect(take(fromArray(["a"]), 5)), ["a"]);

let produced = 0;
async function* infinite(): AsyncGenerator<number> {
	while (true) {
		produced++;
		yield produced;
	}
}
assert.deepEqual(await collect(take(infinite(), 3)), [1, 2, 3]);
assert.equal(produced, 3, "take 取够了就应该停止，不能继续读取");

assert.deepEqual(await collect(lines(fromArray(["第一", "行\n第二行\n第", "三行"]))), ["第一行", "第二行", "第三行"]);
assert.deepEqual(await collect(lines(fromArray(["a\n", "\n", "b\n"]))), ["a", "", "b"]);
console.log("练习 3 全部通过！");
