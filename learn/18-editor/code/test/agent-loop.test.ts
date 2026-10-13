import assert from "node:assert/strict";
import { test } from "node:test";
import { createFauxModel, type Message, type ToolResultMessage } from "../src/ai/index.ts";
import { type AgentEvent, type AgentTool, runAgentLoop } from "../src/agent/index.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

/** 一个记录调用参数的 echo 工具 */
function echoTool(calls: Record<string, unknown>[] = []): AgentTool<{ text: string }> {
	return {
		name: "echo",
		description: "原样返回文字",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		async execute(_id, args) {
			calls.push(args);
			return { content: [{ type: "text", text: `echo: ${args.text}` }] };
		},
	};
}

function collector() {
	const events: AgentEvent[] = [];
	return { events, emit: (event: AgentEvent) => void events.push(event) };
}

function toolResults(messages: Message[]): ToolResultMessage[] {
	return messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

test("没有工具调用：一轮就结束，事件顺序正确", async () => {
	const faux = createFauxModel([{ text: "你好！" }]);
	const { events, emit } = collector();
	const result = await runAgentLoop([user("hi")], { messages: [], tools: [] }, { model: faux.model }, emit);
	assert.deepEqual(
		result.map((m) => m.role),
		["user", "assistant"],
	);
	const types = events.map((e) => e.type).filter((t) => t !== "message_update");
	assert.deepEqual(types, [
		"agent_start",
		"turn_start",
		"message_start",
		"message_end",
		"message_start",
		"message_end",
		"turn_end",
		"agent_end",
	]);
});

test("调用工具 → 执行 → 带着结果再问一次模型", async () => {
	const calls: Record<string, unknown>[] = [];
	const faux = createFauxModel([
		{ text: "我来调用工具。", toolCalls: [{ name: "echo", arguments: { text: "abc" } }] },
		{ text: "工具说 echo: abc" },
	]);
	const { events, emit } = collector();
	const result = await runAgentLoop([user("试试工具")], { messages: [], tools: [echoTool(calls)] }, { model: faux.model }, emit);

	assert.deepEqual(calls, [{ text: "abc" }]);
	assert.deepEqual(
		result.map((m) => m.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	const [toolResult] = toolResults(result);
	assert.equal(toolResult.isError, false);
	assert.deepEqual(toolResult.content, [{ type: "text", text: "echo: abc" }]);
	// 第二次请求里，模型能看到工具结果
	const secondRequest = faux.requests[1];
	assert.equal(secondRequest.messages.at(-1)?.role, "toolResult");
	// 两轮
	assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
	assert.ok(events.some((e) => e.type === "tool_execution_start" && e.toolName === "echo"));
	assert.ok(events.some((e) => e.type === "tool_execution_end" && !e.isError));
});

test("sequential 模式：多个工具调用一个接一个执行，结果按顺序排列", async () => {
	const order: string[] = [];
	const tool: AgentTool<{ n: number }> = {
		name: "wait",
		description: "等一会儿",
		parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
		async execute(_id, args) {
			await new Promise((resolve) => setTimeout(resolve, args.n));
			order.push(String(args.n));
			return { content: [{ type: "text", text: `等了 ${args.n}ms` }] };
		},
	};
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "wait", arguments: { n: 30 } },
				{ name: "wait", arguments: { n: 1 } },
			],
		},
		{ text: "好了" },
	]);
	const result = await runAgentLoop(
		[user("等")],
		{ messages: [], tools: [tool] },
		{ model: faux.model, toolExecution: "sequential" },
		() => {},
	);
	assert.deepEqual(order, ["30", "1"], "按顺序一个一个执行");
	assert.deepEqual(
		toolResults(result).map((r) => r.content[0].text),
		["等了 30ms", "等了 1ms"],
	);
});

test("工具抛出异常：错误信息作为结果发回给模型，循环继续", async () => {
	const broken: AgentTool = {
		name: "broken",
		description: "总是失败",
		parameters: { type: "object", properties: {} },
		async execute() {
			throw new Error("磁盘满了");
		},
	};
	const faux = createFauxModel([{ toolCalls: [{ name: "broken", arguments: {} }] }, { text: "工具失败了，我换个办法" }]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [broken] }, { model: faux.model }, () => {});
	const [toolResult] = toolResults(result);
	assert.equal(toolResult.isError, true);
	assert.equal(toolResult.content[0].text, "磁盘满了");
	assert.equal(result.at(-1)?.role, "assistant");
});

test("工具返回 isError: true（不抛异常）也算失败", async () => {
	const soft: AgentTool = {
		name: "soft",
		description: "报告失败",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "命令退出码 1" }], isError: true };
		},
	};
	const faux = createFauxModel([{ toolCalls: [{ name: "soft", arguments: {} }] }, { text: "嗯" }]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [soft] }, { model: faux.model }, () => {});
	assert.equal(toolResults(result)[0].isError, true);
});

test("调用不存在的工具：返回错误，列出可用的工具", async () => {
	const faux = createFauxModel([{ toolCalls: [{ name: "nope", arguments: {} }] }, { text: "抱歉" }]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [echoTool()] }, { model: faux.model }, () => {});
	const [toolResult] = toolResults(result);
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content[0].text, /没有名为 nope 的工具/);
	assert.match(toolResult.content[0].text, /echo/);
});

test("参数校验失败：不执行工具，错误信息发回给模型", async () => {
	const calls: Record<string, unknown>[] = [];
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { wrong: 1 } }] }, { text: "我改一下参数" }]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [echoTool(calls)] }, { model: faux.model }, () => {});
	assert.equal(calls.length, 0, "参数不对时不能执行工具");
	const [toolResult] = toolResults(result);
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content[0].text, /text：缺少必填参数/);
});

test("参数里的小问题会被自动修正（数字字符串 → 数字）", async () => {
	let received: unknown;
	const tool: AgentTool<{ limit: number }> = {
		name: "count",
		description: "数数",
		parameters: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
		async execute(_id, args) {
			received = args.limit;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const faux = createFauxModel([{ toolCalls: [{ name: "count", arguments: { limit: "10" } }] }, { text: "好" }]);
	await runAgentLoop([user("x")], { messages: [], tools: [tool] }, { model: faux.model }, () => {});
	assert.equal(received, 10);
});

test("回复被截断（length）时，工具调用不执行，返回错误让模型重试", async () => {
	const calls: Record<string, unknown>[] = [];
	const faux = createFauxModel([
		{ toolCalls: [{ name: "echo", arguments: { text: "半截" } }], stopReason: "length" },
		{ text: "我重新来" },
	]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [echoTool(calls)] }, { model: faux.model }, () => {});
	assert.equal(calls.length, 0);
	assert.match(toolResults(result)[0].content[0].text, /输出长度上限/);
	assert.equal(faux.requests.length, 2, "循环继续，模型有机会重试");
});

test("模型出错：循环结束，不再请求", async () => {
	const faux = createFauxModel([{ error: "服务器开小差了" }, { text: "不会走到这里" }]);
	const { events, emit } = collector();
	const result = await runAgentLoop([user("x")], { messages: [], tools: [] }, { model: faux.model }, emit);
	assert.equal(result.at(-1)?.role, "assistant");
	assert.equal(faux.requests.length, 1);
	assert.equal(events.at(-1)?.type, "agent_end");
});

test("工具执行期间取消：剩下的工具调用也有结果，不再请求模型", async () => {
	const controller = new AbortController();
	const slow: AgentTool = {
		name: "slow",
		description: "很慢",
		parameters: { type: "object", properties: {} },
		async execute() {
			controller.abort(); // 模拟用户在工具执行时按下了取消
			return { content: [{ type: "text", text: "做完了" }] };
		},
	};
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "slow", arguments: {} },
				{ name: "slow", arguments: {} },
			],
		},
		{ text: "不会走到这里" },
	]);
	const result = await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [slow] },
		{ model: faux.model },
		() => {},
		controller.signal,
	);
	const results = toolResults(result);
	assert.equal(results.length, 2, "每个工具调用都必须有结果");
	assert.equal(results[1].isError, true);
	assert.match(results[1].content[0].text, /取消/);
	assert.equal(faux.requests.length, 1);
});

test("工具可以报告进度，进度事件在结束事件之前", async () => {
	const tool: AgentTool = {
		name: "progress",
		description: "报告进度",
		parameters: { type: "object", properties: {} },
		async execute(_id, _args, _signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "50%" }] });
			onUpdate?.({ content: [{ type: "text", text: "100%" }] });
			return { content: [{ type: "text", text: "完成" }] };
		},
	};
	const faux = createFauxModel([{ toolCalls: [{ name: "progress", arguments: {} }] }, { text: "好" }]);
	const { events, emit } = collector();
	await runAgentLoop([user("x")], { messages: [], tools: [tool] }, { model: faux.model }, emit);
	const toolEvents = events.filter((e) => e.type.startsWith("tool_execution")).map((e) => e.type);
	assert.deepEqual(toolEvents, [
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_update",
		"tool_execution_end",
	]);
});

test("不修改调用者传入的 context.messages", async () => {
	const faux = createFauxModel([{ text: "好" }]);
	const history: Message[] = [user("之前的问题")];
	await runAgentLoop([user("新问题")], { messages: history, tools: [] }, { model: faux.model }, () => {});
	assert.equal(history.length, 1);
	assert.equal(faux.requests[0].messages.length, 2, "模型能看到之前的历史和新问题");
});

// ---------- 里程碑 10：并行执行、插话、排队 ----------

/** 等待 ms 毫秒后返回的工具，记录完成的顺序 */
function waitTool(order: string[]): AgentTool<{ ms: number }> {
	return {
		name: "wait",
		description: "等一会儿",
		parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
		async execute(_id, args) {
			await new Promise((resolve) => setTimeout(resolve, args.ms));
			order.push(String(args.ms));
			return { content: [{ type: "text", text: `等了 ${args.ms}ms` }] };
		},
	};
}

test("parallel 模式（默认）：多个工具同时执行，结果消息仍按调用顺序排列", async () => {
	const order: string[] = [];
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "wait", arguments: { ms: 60 } },
				{ name: "wait", arguments: { ms: 60 } },
				{ name: "wait", arguments: { ms: 1 } },
			],
		},
		{ text: "好了" },
	]);
	const started = Date.now();
	const result = await runAgentLoop([user("等")], { messages: [], tools: [waitTool(order)] }, { model: faux.model }, () => {});
	const elapsed = Date.now() - started;
	assert.deepEqual(order, ["1", "60", "60"], "短的先完成");
	assert.ok(elapsed < 110, `同时执行，总时间约等于最慢的那个（实际 ${elapsed}ms）`);
	assert.deepEqual(
		toolResults(result).map((r) => r.content[0].text),
		["等了 60ms", "等了 60ms", "等了 1ms"],
		"结果消息按调用的顺序",
	);
});

test("parallel 模式的事件顺序：start 按调用顺序，end 按完成顺序，结果消息按调用顺序", async () => {
	const faux = createFauxModel([
		{
			toolCalls: [
				{ id: "slow", name: "wait", arguments: { ms: 30 } },
				{ id: "fast", name: "wait", arguments: { ms: 1 } },
			],
		},
		{ text: "好了" },
	]);
	const { events, emit } = collector();
	await runAgentLoop([user("等")], { messages: [], tools: [waitTool([])] }, { model: faux.model }, emit);
	const trace = events.flatMap((e) => {
		if (e.type === "tool_execution_start") return [`start:${e.toolCallId}`];
		if (e.type === "tool_execution_end") return [`end:${e.toolCallId}`];
		if (e.type === "message_end" && e.message.role === "toolResult") return [`result:${e.message.toolCallId}`];
		return [];
	});
	assert.deepEqual(trace, ["start:slow", "start:fast", "end:fast", "end:slow", "result:slow", "result:fast"]);
});

test("parallel 模式：准备失败的调用（比如工具不存在）不影响其他调用", async () => {
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "nope", arguments: {} },
				{ name: "echo", arguments: { text: "ok" } },
			],
		},
		{ text: "好了" },
	]);
	const result = await runAgentLoop([user("x")], { messages: [], tools: [echoTool()] }, { model: faux.model }, () => {});
	const results = toolResults(result);
	assert.equal(results[0].isError, true);
	assert.equal(results[1].isError, false);
	assert.equal(results[1].content[0].text, "echo: ok");
});

test("parallel 模式下取消：每个调用都有结果", async () => {
	const controller = new AbortController();
	const tool: AgentTool = {
		name: "slow",
		description: "很慢，支持取消",
		parameters: { type: "object", properties: {} },
		execute(_id, _args, signal) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "做完了" }] }), 1000);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("被取消了"));
				});
			});
		},
	};
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "slow", arguments: {} },
				{ name: "slow", arguments: {} },
			],
		},
		{ text: "不会走到这里" },
	]);
	setTimeout(() => controller.abort(), 20);
	const result = await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [tool] },
		{ model: faux.model },
		() => {},
		controller.signal,
	);
	const results = toolResults(result);
	assert.equal(results.length, 2);
	assert.ok(results.every((r) => r.isError));
	assert.equal(faux.requests.length, 1);
});

test("插话（steering）：在当前轮的工具执行完之后、下一次请求之前加入对话", async () => {
	const steering = [[], [user("顺便看看 b.txt")]];
	const faux = createFauxModel([
		{ toolCalls: [{ name: "echo", arguments: { text: "a.txt" } }] },
		{ text: "好的，我也看了 b.txt" },
	]);
	const result = await runAgentLoop(
		[user("看看 a.txt")],
		{ messages: [], tools: [echoTool()] },
		// 第 1 次调用（启动时）没有插话，第 2 次调用（第 1 轮结束后）有一条
		{ model: faux.model, getSteeringMessages: () => steering.shift() ?? [] },
		() => {},
	);
	assert.deepEqual(
		result.map((m) => m.role),
		["user", "assistant", "toolResult", "user", "assistant"],
		"插话排在工具结果后面",
	);
	assert.equal(faux.requests[1].messages.at(-1)?.role, "user", "第二次请求能看到插话");
});

test("插话在模型给出最终回答时到达：循环继续，处理这条插话", async () => {
	const steering = [[], [user("再补充一句")]];
	const faux = createFauxModel([{ text: "回答完毕" }, { text: "好的，补充如下" }]);
	const result = await runAgentLoop(
		[user("问题")],
		{ messages: [], tools: [] },
		{ model: faux.model, getSteeringMessages: () => steering.shift() ?? [] },
		() => {},
	);
	assert.equal(faux.requests.length, 2);
	assert.deepEqual(
		result.map((m) => m.role),
		["user", "assistant", "user", "assistant"],
	);
});

test("排队（follow-up）：agent 本来要停下时才处理", async () => {
	const followUps = [[user("然后呢？")]];
	let followUpCalls = 0;
	const faux = createFauxModel([
		{ toolCalls: [{ name: "echo", arguments: { text: "1" } }] },
		{ text: "第一个问题答完了" },
		{ text: "第二个问题也答完了" },
	]);
	const { events, emit } = collector();
	const result = await runAgentLoop(
		[user("问题")],
		{ messages: [], tools: [echoTool()] },
		{
			model: faux.model,
			getFollowUpMessages: () => {
				followUpCalls++;
				return followUps.shift() ?? [];
			},
		},
		emit,
	);
	assert.deepEqual(
		result.map((m) => m.role),
		["user", "assistant", "toolResult", "assistant", "user", "assistant"],
		"排队的消息在最终回答之后才处理",
	);
	assert.equal(followUpCalls, 2, "只在本来要停下时检查：第一次取到消息，第二次没有了");
	assert.equal(events.filter((e) => e.type === "agent_end").length, 1, "整个过程是一次运行");
});

// ---------- 里程碑 12：beforeToolCall ----------

test("beforeToolCall 阻止执行：工具不执行，原因作为错误信息发给模型", async () => {
	const calls: Record<string, unknown>[] = [];
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { text: "rm -rf /" } }] }, { text: "好吧" }]);
	const result = await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [echoTool(calls)] },
		{ model: faux.model, beforeToolCall: () => ({ block: true, reason: "用户拒绝了" }) },
		() => {},
	);
	assert.equal(calls.length, 0);
	const [toolResult] = toolResults(result);
	assert.equal(toolResult.isError, true);
	assert.equal(toolResult.content[0].text, "用户拒绝了");
});

test("beforeToolCall 收到校验、修正过的参数；返回 undefined 表示允许", async () => {
	const seen: unknown[] = [];
	const tool: AgentTool<{ n: number }> = {
		name: "count",
		description: "数数",
		parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const faux = createFauxModel([{ toolCalls: [{ name: "count", arguments: { n: "5" } }] }, { text: "好" }]);
	const result = await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [tool] },
		{ model: faux.model, beforeToolCall: ({ args }) => void seen.push(args) },
		() => {},
	);
	assert.deepEqual(seen, [{ n: 5 }]);
	assert.equal(toolResults(result)[0].isError, false);
});

test("beforeToolCall 抛出异常：等于阻止，异常信息发给模型", async () => {
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { text: "a" } }] }, { text: "好" }]);
	const result = await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [echoTool()] },
		{
			model: faux.model,
			beforeToolCall: () => {
				throw new Error("权限检查失败");
			},
		},
		() => {},
	);
	assert.equal(toolResults(result)[0].content[0].text, "权限检查失败");
});

test("parallel 模式：先依次确认所有调用，再一起执行", async () => {
	const log: string[] = [];
	const tool: AgentTool<{ id: string }> = {
		name: "job",
		description: "任务",
		parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		async execute(_toolCallId, args) {
			log.push(`执行 ${args.id}`);
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "job", arguments: { id: "A" } },
				{ name: "job", arguments: { id: "B" } },
			],
		},
		{ text: "好" },
	]);
	await runAgentLoop(
		[user("x")],
		{ messages: [], tools: [tool] },
		{
			model: faux.model,
			beforeToolCall: async ({ args }) => {
				await new Promise((resolve) => setTimeout(resolve, 10)); // 比如：等用户回答
				log.push(`确认 ${args.id}`);
				return undefined;
			},
		},
		() => {},
	);
	assert.deepEqual(log, ["确认 A", "确认 B", "执行 A", "执行 B"]);
});

// ---------- 里程碑 15：prepareNextTurn ----------

test("prepareNextTurn：每一轮开始前调用，可以替换对话", async () => {
	const seen: number[] = [];
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { text: "a" } }] }, { text: "好" }]);
	await runAgentLoop(
		[user("原来的问题")],
		{ messages: [], tools: [echoTool()] },
		{
			model: faux.model,
			prepareNextTurn: (messages) => {
				seen.push(messages.length);
				return [user("（压缩后的对话）")];
			},
		},
		() => {},
	);
	assert.deepEqual(seen, [3], "第一轮之前不调用；第二轮之前调用一次，这时对话里有 3 条消息");
	assert.deepEqual(
		faux.requests[1].messages.map((m) => (m.role === "user" ? m.content : m.role)),
		["（压缩后的对话）"],
		"第二次请求用的是替换后的对话",
	);
});
