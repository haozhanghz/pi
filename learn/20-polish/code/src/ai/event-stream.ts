// 事件流：生产者 push 事件，消费者用 for await 读取，最后还能拿到一个"最终结果"。
// 对应 pi 的 packages/ai/src/utils/event-stream.ts。
import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

/**
 * 一个通用的事件流。
 * - T：事件的类型
 * - R：最终结果的类型
 *
 * 生产者调用 push(event) 推送事件，调用 end() 结束；
 * 消费者用 for await (const event of stream) 读取，或者 await stream.result() 只拿最终结果。
 */
export class EventStream<T, R> implements AsyncIterable<T> {
	/** 已经推送、但还没有被消费者取走的事件 */
	private queue: T[] = [];
	/** 正在等待下一个事件的消费者 */
	private waiting: ((result: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResult: Promise<R>;
	private resolveFinal: (result: R) => void = () => {};
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	/**
	 * @param isComplete 判断一个事件是不是"最后一个事件"
	 * @param extractResult 从最后一个事件里取出最终结果
	 */
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResult = new Promise<R>((resolve) => {
			this.resolveFinal = resolve;
		});
	}

	/** 推送一个事件。流结束之后再推送的事件会被忽略。 */
	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinal(this.extractResult(event));
		}
		// 有消费者在等，就直接交给它；否则放进队列
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	/** 结束这个流。可以顺便提供最终结果（如果之前没有通过"最后一个事件"提供过）。 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) this.resolveFinal(result);
		// 叫醒所有还在等待的消费者，告诉它们"没有更多事件了"
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift() as T;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/** 最终结果。流结束（收到最后一个事件）时兑现。 */
	result(): Promise<R> {
		return this.finalResult;
	}
}

/** 一次模型回复的事件流：以 done 或 error 事件结束，最终结果是完整的 AssistantMessage */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("不是最后一个事件");
			},
		);
	}
}
