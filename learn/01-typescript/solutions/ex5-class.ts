// 练习 5：类与泛型（参考答案）
import assert from "node:assert/strict";

/**
 * 一个先进先出（FIFO）的队列。
 * 里程碑 10 的 Agent 会用它保存"用户在 agent 工作时插进来的消息"。
 */
class Queue<T> {
	private items: T[] = [];

	/** 放到队尾 */
	enqueue(item: T): void {
		this.items.push(item);
	}

	/** 从队头取出一个；队列为空时返回 undefined */
	dequeue(): T | undefined {
		return this.items.shift();
	}

	/** 看一眼队头但不取出 */
	peek(): T | undefined {
		return this.items[0];
	}

	/** 取出全部，队列变空 */
	drain(): T[] {
		const all = this.items;
		this.items = [];
		return all;
	}

	get size(): number {
		return this.items.length;
	}
}

/** 只保留最近 limit 条记录的历史（比如输入框的上下键历史） */
class History {
	private entries: string[] = [];
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	/** 加入一条；空字符串和"与上一条相同"的不加入；超过上限时丢掉最旧的 */
	add(entry: string): void {
		if (entry === "" || entry === this.entries.at(-1)) return;
		this.entries.push(entry);
		if (this.entries.length > this.limit) this.entries.shift();
	}

	/** 从新到旧返回所有记录（返回副本，外部修改不影响内部） */
	list(): string[] {
		return [...this.entries].reverse();
	}
}

// ----- 检查（不要修改下面的代码） -----
const queue = new Queue<string>();
assert.equal(queue.size, 0);
assert.equal(queue.dequeue(), undefined);
queue.enqueue("第一条");
queue.enqueue("第二条");
queue.enqueue("第三条");
assert.equal(queue.size, 3);
assert.equal(queue.peek(), "第一条");
assert.equal(queue.dequeue(), "第一条");
assert.deepEqual(queue.drain(), ["第二条", "第三条"]);
assert.equal(queue.size, 0);

const numbers = new Queue<number>();
numbers.enqueue(42);
assert.equal(numbers.dequeue(), 42);

const history = new History(3);
history.add("ls");
history.add("ls");
history.add("");
history.add("pwd");
history.add("cat a.txt");
history.add("git status");
assert.deepEqual(history.list(), ["git status", "cat a.txt", "pwd"]);
history.list().pop();
assert.equal(history.list().length, 3, "list() 应该返回副本");
console.log("练习 5 全部通过！");
