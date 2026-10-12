// parseSSE 的单元测试（练习 3 的参考答案）。运行：node --test test/sse.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSSE, type SseEvent } from "../playground/sse.ts";

/** 把一段文字编码成字节，再按照给定的位置切成多块，模拟网络传输 */
async function* chunked(text: string, cuts: number[]): AsyncGenerator<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let start = 0;
	for (const cut of [...cuts, bytes.length]) {
		yield bytes.slice(start, cut);
		start = cut;
	}
}

/** 每个字节单独一块：最极端的切法 */
async function* byteByByte(text: string): AsyncGenerator<Uint8Array> {
	for (const byte of new TextEncoder().encode(text)) yield new Uint8Array([byte]);
}

async function collect(source: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of source) events.push(event);
	return events;
}

test("一块里有多个事件", async () => {
	const events = await collect(parseSSE(chunked("data: a\n\ndata: b\n\n", [])));
	assert.deepEqual(
		events.map((e) => e.data),
		["a", "b"],
	);
});

test("一个事件被切成多块", async () => {
	const events = await collect(parseSSE(chunked('data: {"x":1}\n\n', [3, 8, 12])));
	assert.deepEqual(events, [{ event: undefined, data: '{"x":1}' }]);
});

test("每个字节单独一块，汉字也能正确拼回来", async () => {
	const events = await collect(parseSSE(byteByByte("data: 你好，世界\n\ndata: 第二个\n\n")));
	assert.deepEqual(
		events.map((e) => e.data),
		["你好，世界", "第二个"],
	);
});

test("event 字段、注释行、多行 data", async () => {
	const text = ": 这是心跳注释\nevent: message_start\ndata: 第一行\ndata: 第二行\n\n";
	const events = await collect(parseSSE(chunked(text, [5])));
	assert.deepEqual(events, [{ event: "message_start", data: "第一行\n第二行" }]);
});

test("兼容 \\r\\n 换行", async () => {
	const events = await collect(parseSSE(chunked("data: a\r\n\r\ndata: b\r\n\r\n", [8])));
	assert.deepEqual(
		events.map((e) => e.data),
		["a", "b"],
	);
});

test("最后一个事件没有空行结尾，也不会丢", async () => {
	const events = await collect(parseSSE(chunked("data: a\n\ndata: last", [])));
	assert.deepEqual(
		events.map((e) => e.data),
		["a", "last"],
	);
});

test("冒号后面没有空格也可以", async () => {
	const events = await collect(parseSSE(chunked("data:紧挨着\n\n", [])));
	assert.equal(events[0].data, "紧挨着");
});
