import assert from "node:assert/strict";
import { test } from "node:test";
import { EventStream } from "../src/ai/event-stream.ts";

type Ev = { type: "data"; value: number } | { type: "end"; total: number };

function createStream() {
	return new EventStream<Ev, number>(
		(event) => event.type === "end",
		(event) => (event.type === "end" ? event.total : 0),
	);
}

test("先推送再读取：事件按顺序取出", async () => {
	const stream = createStream();
	stream.push({ type: "data", value: 1 });
	stream.push({ type: "data", value: 2 });
	stream.push({ type: "end", total: 3 });
	const seen: Ev[] = [];
	for await (const event of stream) seen.push(event);
	assert.deepEqual(seen, [
		{ type: "data", value: 1 },
		{ type: "data", value: 2 },
		{ type: "end", total: 3 },
	]);
});

test("先开始读取再推送：消费者会等待新事件", async () => {
	const stream = createStream();
	const seen: number[] = [];
	const consumer = (async () => {
		for await (const event of stream) seen.push(event.type === "data" ? event.value : -1);
	})();
	await new Promise((resolve) => setTimeout(resolve, 10));
	stream.push({ type: "data", value: 7 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	stream.push({ type: "end", total: 7 });
	await consumer;
	assert.deepEqual(seen, [7, -1]);
});

test("result() 在最后一个事件到达时兑现", async () => {
	const stream = createStream();
	setTimeout(() => {
		stream.push({ type: "data", value: 1 });
		stream.push({ type: "end", total: 42 });
	}, 5);
	assert.equal(await stream.result(), 42);
});

test("最后一个事件之后推送的事件会被忽略", async () => {
	const stream = createStream();
	stream.push({ type: "end", total: 1 });
	stream.push({ type: "data", value: 99 });
	const seen: Ev[] = [];
	for await (const event of stream) seen.push(event);
	assert.equal(seen.length, 1);
});

test("end() 会让正在等待的消费者结束循环", async () => {
	const stream = createStream();
	const consumer = (async () => {
		let count = 0;
		for await (const _ of stream) count++;
		return count;
	})();
	await new Promise((resolve) => setTimeout(resolve, 10));
	stream.end(0);
	assert.equal(await consumer, 0);
	assert.equal(await stream.result(), 0);
});
