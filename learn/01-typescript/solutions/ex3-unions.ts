// 练习 3：联合类型与类型收窄（参考答案）
import assert from "node:assert/strict";

/** 流式输出时，模型会发来一个个"事件"。这里是简化版。 */
type StreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "toolcall"; name: string; args: Record<string, unknown> }
	| { type: "done"; reason: "stop" | "length" | "toolUse" }
	| { type: "error"; message: string };

/** 把一个事件描述成一句中文 */
function describe(event: StreamEvent): string {
	switch (event.type) {
		case "text_delta":
			return `收到文字：${event.delta}`;
		case "toolcall":
			return `要调用工具 ${event.name}`;
		case "done":
			return `结束（${event.reason}）`;
		case "error":
			return `出错：${event.message}`;
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** 把所有 text_delta 的文字按顺序拼起来 */
function collectText(events: StreamEvent[]): string {
	let text = "";
	for (const event of events) {
		if (event.type === "text_delta") text += event.delta;
	}
	return text;
}

/** 根据最后一个事件判断状态："完成" / "出错：xxx" / "未结束" */
function finalStatus(events: StreamEvent[]): string {
	const last = events.at(-1);
	if (last?.type === "done") return "完成";
	if (last?.type === "error") return `出错：${last.message}`;
	return "未结束";
}

/** 收集所有被调用的工具名 */
function toolNames(events: StreamEvent[]): string[] {
	const names: string[] = [];
	for (const event of events) {
		if (event.type === "toolcall") names.push(event.name);
	}
	return names;
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
