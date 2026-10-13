import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../src/tui/ansi.ts";
import { type SelectItem, SelectList } from "../src/tui/components/select-list.ts";
import { KeyBuffer } from "../src/tui/keys.ts";

const items: SelectItem[] = [
	{ value: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat", description: "DeepSeek" },
	{ value: "qwen/qwen-plus", label: "qwen/qwen-plus", description: "通义千问" },
	{ value: "moonshot/kimi", label: "moonshot/kimi", description: "Kimi" },
	{ value: "fake/fake-model", label: "fake/fake-model", description: "假模型" },
];

function press(list: SelectList, data: string): void {
	const keys = new KeyBuffer();
	for (const key of [...keys.push(data), ...keys.flush()]) list.handleInput(key);
}

test("上下移动，回车选择；到头了转到另一头", () => {
	const list = new SelectList(items);
	const selected: string[] = [];
	list.onSelect = (item) => selected.push(item.value);
	press(list, "\x1b[B\x1b[B\r"); // 下、下、回车
	press(list, "\x1b[A\x1b[A\x1b[A\r"); // 上、上、上：从第三项转到最后一项
	assert.deepEqual(selected, ["moonshot/kimi", "fake/fake-model"]);
});

test("一开始选中指定的项", () => {
	const list = new SelectList(items, { selectedValue: "qwen/qwen-plus" });
	assert.equal(stripAnsi(list.render(60)[2]), " › qwen/qwen-plus  通义千问");
});

test("打字筛选：名字和说明都能匹配，中文也可以；退格删除筛选的字", () => {
	const list = new SelectList(items);
	press(list, "通义");
	assert.deepEqual(list.render(60).map(stripAnsi), [" 筛选：通义", " › qwen/qwen-plus  通义千问"]);
	press(list, "\x7f\x7f");
	assert.equal(list.render(60).length, 5, "筛选清空后显示全部");
	press(list, "xyz");
	assert.deepEqual(list.render(60).map(stripAnsi).slice(1), ["   没有匹配的结果"]);
});

test("Esc 取消", () => {
	const list = new SelectList(items);
	let cancelled = false;
	list.onCancel = () => {
		cancelled = true;
	};
	press(list, "\x1b");
	assert.ok(cancelled);
});

test("项目太多时滚动，选中的始终看得见", () => {
	const many = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `项目 ${i}` }));
	const list = new SelectList(many, { maxVisible: 3 });
	press(list, "\x1b[B".repeat(5));
	assert.deepEqual(list.render(40).map(stripAnsi).slice(1), ["   项目 3", "   项目 4", " › 项目 5", "   （6/20，上下方向键滚动）"]);
});
