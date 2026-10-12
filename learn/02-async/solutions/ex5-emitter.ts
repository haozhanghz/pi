// 练习 5：订阅模式（参考答案）
import assert from "node:assert/strict";

/**
 * 一个最简单的"事件发射器"：
 * - subscribe(listener)：注册一个监听函数，返回一个"取消订阅"的函数；
 * - emit(event)：把事件依次交给所有监听函数（按注册顺序）。
 * 里程碑 10 的 Agent 就是用这种方式把"模型吐字了""工具开始执行了"等事件通知给界面的。
 */
interface Emitter<T> {
	subscribe(listener: (event: T) => void): () => void;
	emit(event: T): void;
	readonly listenerCount: number;
}

function createEmitter<T>(): Emitter<T> {
	const listeners = new Set<(event: T) => void>();
	return {
		subscribe(listener: (event: T) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(event: T): void {
			for (const listener of listeners) listener(event);
		},
		get listenerCount(): number {
			return listeners.size;
		},
	};
}

// ----- 检查（不要修改下面的代码） -----
type AgentEvent = { type: "start" } | { type: "text"; delta: string } | { type: "end" };

const emitter = createEmitter<AgentEvent>();
const seenByA: string[] = [];
const seenByB: string[] = [];

const unsubscribeA = emitter.subscribe((event) => seenByA.push(event.type));
emitter.subscribe((event) => {
	if (event.type === "text") seenByB.push(event.delta);
});
assert.equal(emitter.listenerCount, 2);

emitter.emit({ type: "start" });
emitter.emit({ type: "text", delta: "你" });
emitter.emit({ type: "text", delta: "好" });
unsubscribeA();
emitter.emit({ type: "end" });

assert.deepEqual(seenByA, ["start", "text", "text"], "取消订阅后 A 不应该再收到事件");
assert.deepEqual(seenByB, ["你", "好"]);
assert.equal(emitter.listenerCount, 1);
console.log("练习 5 全部通过！");
