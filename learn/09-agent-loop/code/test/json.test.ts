import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePartialJson } from "../src/ai/json.ts";

test("完整的 JSON 正常解析", () => {
	assert.deepEqual(parsePartialJson('{"path": "a.txt", "limit": 10}'), { path: "a.txt", limit: 10 });
});

test("字符串写到一半", () => {
	assert.deepEqual(parsePartialJson('{"path": "src/ma'), { path: "src/ma" });
	assert.deepEqual(parsePartialJson('{"path": "a.txt", "content": "第一行\\n第二'), {
		path: "a.txt",
		content: "第一行\n第二",
	});
});

test("嵌套的数组和对象写到一半", () => {
	assert.deepEqual(parsePartialJson('{"edits": [{"oldText": "a", "newText": "b"}, {"oldText": "c'), {
		edits: [
			{ oldText: "a", newText: "b" },
			{ oldText: "c" },
		],
	});
});

test("末尾是逗号、冒号、写了一半的字面量", () => {
	assert.deepEqual(parsePartialJson('{"a": 1,'), { a: 1 });
	assert.deepEqual(parsePartialJson('{"a": 1, "b":'), { a: 1, b: null });
	assert.deepEqual(parsePartialJson('{"a": 1, "b": tru'), { a: 1, b: null });
});

test("字符串里的转义引号不会被当成结束", () => {
	assert.deepEqual(parsePartialJson('{"cmd": "echo \\"hi'), { cmd: 'echo "hi' });
	assert.deepEqual(parsePartialJson('{"cmd": "a\\'), { cmd: "a" });
});

test("空字符串、数组、乱码都返回空对象", () => {
	assert.deepEqual(parsePartialJson(""), {});
	assert.deepEqual(parsePartialJson("[1, 2]"), {});
	assert.deepEqual(parsePartialJson("not json"), {});
});

test("字符串里有未转义的换行符（有些模型会这样输出），也能解析", () => {
	assert.deepEqual(parsePartialJson('{"content": "第一行\n第二行"}'), { content: "第一行\n第二行" });
	assert.deepEqual(parsePartialJson('{"content": "a\tb'), { content: "a\tb" });
});
