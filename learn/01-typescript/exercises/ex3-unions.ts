// 练习 3：联合类型与类型收窄
// 完成下面四个函数，然后运行：node exercises/ex3-unions.ts
// 额外挑战：在 describe 的 switch 里加上 default 分支做"穷尽检查"（见章节第 7 节）。
import assert from "node:assert/strict";

/** 流式输出时，模型会发来一个个"事件"。这里是简化版。 */
type StreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "toolcall"; name: string; args: Record<string, unknown> }
	| { type: "done"; reason: "stop" | "length" | "toolUse" }
	| { type: "error"; message: string };

/** 把一个事件描述成一句中文（格式见下面的检查） */
function describe(event: StreamEvent): string {
	// 提示：switch (event.type) { case "text_delta": ... }
	throw new Error("TODO：请实现 describe");
}

/** 把所有 text_delta 的文字按顺序拼起来 */
function collectText(events: StreamEvent[]): string {
	throw new Error("TODO：请实现 collectText");
}

/** 根据最后一个事件判断状态："完成" / "出错：xxx" / "未结束" */
function finalStatus(events: StreamEvent[]): string {
	// 提示：events.at(-1) 取最后一个元素，空数组时得到 undefined，可以用 ?. 安全访问
	throw new Error("TODO：请实现 finalStatus");
}

/** 收集所有被调用的工具名 */
function toolNames(events: StreamEvent[]): string[] {
	throw new Error("TODO：请实现 toolNames");
}

// ----- 检查（不要修改下面的代码） -----
const events: StreamEvent[] = [
	{ type: "text_delta", delta: "我来" },
	{ type: "text_delta", delta: "读取文件。" },
	{ type: "toolcall", name: "read", args: { path: "a.txt" } },
	{ type: "done", reason: "toolUse" },
];
assert.equal(describe(events[0]), "收到文字：我来");
assert.equal(describe(events[2]), "要调用工具 read");
assert.equal(describe(events[3]), "结束（toolUse）");
assert.equal(describe({ type: "error", message: "网络断了" }), "出错：网络断了");
assert.equal(collectText(events), "我来读取文件。");
assert.equal(finalStatus(events), "完成");
assert.equal(finalStatus([...events.slice(0, 2), { type: "error", message: "超时" }]), "出错：超时");
assert.equal(finalStatus(events.slice(0, 2)), "未结束");
assert.equal(finalStatus([]), "未结束");
assert.deepEqual(toolNames(events), ["read"]);
console.log("练习 3 全部通过！");
