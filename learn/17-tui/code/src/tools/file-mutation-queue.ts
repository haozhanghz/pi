// 修改同一个文件的操作排队执行，修改不同文件的操作仍然同时执行。
// 问题：模型同时调用两次 edit 修改同一个文件，两个操作都先读文件、再写回去，后写的会覆盖先写的。
// 对应 pi 的 packages/coding-agent/src/core/tools/file-mutation-queue.ts。
import { resolve } from "node:path";

/** 每个文件一条队列：存着队列里最后一个操作的 Promise */
const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = queues.get(key) ?? Promise.resolve();
	const result = previous.then(fn); // 等前一个操作完成后，再执行这个操作
	const done = result.then(
		() => {},
		() => {},
	); // 不管成功还是失败，都表示"这个操作结束了"，后面的操作可以开始
	queues.set(key, done);
	try {
		return await result;
	} finally {
		// 如果后面没有新的操作排队，就把这个文件的队列删掉，免得 Map 越来越大
		if (queues.get(key) === done) queues.delete(key);
	}
}
