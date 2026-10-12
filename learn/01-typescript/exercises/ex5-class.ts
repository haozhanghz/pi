// 练习 5：类与泛型
// 完成 Queue 和 History 两个类，然后运行：node exercises/ex5-class.ts
// 注意：不能写 constructor(private limit: number) 这种"参数属性"，Node 不支持（见章节第 12 节）。
import assert from "node:assert/strict";

/**
 * 一个先进先出（FIFO）的队列。
 * 里程碑 10 的 Agent 会用它保存"用户在 agent 工作时插进来的消息"。
 */
class Queue<T> {
	private items: T[] = [];

	/** 放到队尾 */
	enqueue(item: T): void {
		throw new Error("TODO：请实现 enqueue");
	}

	/** 从队头取出一个；队列为空时返回 undefined */
	dequeue(): T | undefined {
		// 提示：数组的 shift() 方法取出并返回第一个元素
		throw new Error("TODO：请实现 dequeue");
	}

	/** 看一眼队头但不取出 */
	peek(): T | undefined {
		throw new Error("TODO：请实现 peek");
	}

	/** 取出全部，队列变空 */
	drain(): T[] {
		throw new Error("TODO：请实现 drain");
	}

	get size(): number {
		throw new Error("TODO：请实现 size");
	}
}

/** 只保留最近 limit 条记录的历史（比如输入框的上下键历史） */
class History {
	private entries: string[] = [];
	// TODO：声明一个 limit 字段，并在构造函数里赋值

	constructor(limit: number) {
		throw new Error("TODO：请实现构造函数");
	}

	/** 加入一条；空字符串和"与上一条相同"的不加入；超过上限时丢掉最旧的 */
	add(entry: string): void {
		throw new Error("TODO：请实现 add");
	}

	/** 从新到旧返回所有记录（返回副本，外部修改不影响内部） */
	list(): string[] {
		throw new Error("TODO：请实现 list");
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
