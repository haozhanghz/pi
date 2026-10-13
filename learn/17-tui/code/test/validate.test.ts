import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments, validateValue } from "../src/agent/index.ts";
import type { Tool } from "../src/ai/index.ts";

const tool: Tool = {
	name: "edit",
	description: "修改文件",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			mode: { type: "string", enum: ["replace", "append"] },
			limit: { type: "integer" },
			dryRun: { type: "boolean" },
			edits: {
				type: "array",
				items: {
					type: "object",
					properties: { oldText: { type: "string" }, newText: { type: "string" } },
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path"],
	},
};

test("合法的参数原样通过", () => {
	const args = { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] };
	assert.deepEqual(validateToolArguments(tool, args), args);
});

test("缺少必填参数、类型不对、不在 enum 里", () => {
	const errors = validateValue(tool.parameters, { mode: "delete", limit: 1.5 }, "参数");
	assert.ok(errors.some((e) => e.includes("参数.path：缺少必填参数")));
	assert.ok(errors.some((e) => e.includes("参数.mode：必须是")));
	assert.ok(errors.some((e) => e.includes("参数.limit：必须是整数")));
});

test("数组里的元素也会被检查", () => {
	const errors = validateValue(tool.parameters, { path: "a", edits: [{ oldText: "x" }] }, "参数");
	assert.deepEqual(errors, ["参数.edits[0].newText：缺少必填参数"]);
});

test("自动修正：数字字符串、布尔字符串、可选参数为 null", () => {
	const fixed = validateToolArguments(tool, { path: "a", limit: "20", dryRun: "true", mode: null });
	assert.deepEqual(fixed, { path: "a", limit: 20, dryRun: true });
});

test("校验失败时抛出的错误信息包含问题和收到的参数", () => {
	assert.throws(
		() => validateToolArguments(tool, { path: 123 }),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("工具 edit 的参数不正确") &&
			error.message.includes("参数.path：必须是字符串") &&
			error.message.includes('"path": 123'),
	);
});

test("自动修正：需要数组时给了 JSON 字符串或单个对象", () => {
	const fromString = validateToolArguments(tool, { path: "a", edits: '[{"oldText":"x","newText":"y"}]' });
	assert.deepEqual(fromString, { path: "a", edits: [{ oldText: "x", newText: "y" }] });
	const fromObject = validateToolArguments(tool, { path: "a", edits: { oldText: "x", newText: "y" } });
	assert.deepEqual(fromObject, { path: "a", edits: [{ oldText: "x", newText: "y" }] });
});

test("不是合法 JSON 的字符串不会被修正，校验照常报错", () => {
	assert.throws(() => validateToolArguments(tool, { path: "a", edits: "[{oops" }), /参数.edits：必须是数组/);
});
