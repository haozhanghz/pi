import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent/index.ts";
import { type AssistantMessage, createFauxModel } from "../src/ai/index.ts";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { isContextOverflow, isRetryableError, retryDelayMs, sleep } from "../src/core/retry.ts";
import { SessionManager } from "../src/core/session.ts";

function failure(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

/** 收集会话的事件，只保留和重试、压缩有关的 */
function recordEvents(session: AgentSession): string[] {
	const events: string[] = [];
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "retry_start") events.push(`retry_start ${event.attempt}/${event.maxRetries} ${event.delayMs}ms`);
		if (event.type === "retry_end") events.push(`retry_end ${event.success ? "成功" : "失败"} ${event.attempt}`);
		if (event.type === "compaction_start") events.push(`compaction_start ${event.reason}`);
	});
	return events;
}

test("哪些错误值得重试", () => {
	assert.ok(isRetryableError(failure("HTTP 503：服务器太忙")));
	assert.ok(isRetryableError(failure("HTTP 429：Rate limit reached")));
	assert.ok(isRetryableError(failure("fetch failed")));
	assert.ok(!isRetryableError(failure("HTTP 401：无效的 API key")), "认证失败，重试也没用");
	assert.ok(!isRetryableError(failure("HTTP 429：insufficient_quota")), "额度用完了，重试也没用");
	assert.ok(isContextOverflow(failure("HTTP 400：This model's maximum context length is 128000 tokens")));
});

test("等待时间每次翻倍；可以中途取消", async () => {
	const settings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };
	assert.deepEqual([1, 2, 3].map((attempt) => retryDelayMs(settings, attempt)), [2000, 4000, 8000]);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 10);
	assert.equal(await sleep(10_000, controller.signal), false);
});

test("Agent.continue()：不加新消息，从当前的对话继续", async () => {
	const faux = createFauxModel([{ text: "第一次" }, { text: "第二次" }]);
	const agent = new Agent({ model: faux.model });
	await agent.prompt("你好");
	await assert.rejects(agent.continue(), /最后一条是助手的回复/);
	agent.state.messages.pop();
	await agent.continue();
	assert.deepEqual(
		agent.state.messages.map((message) => message.role),
		["user", "assistant"],
	);
	assert.equal(faux.requests[1].messages.length, 1, "第二次请求只有那条用户消息");
});

test("临时性的错误：等一会儿自动重试，成功后对话里没有失败的回复", async () => {
	const faux = createFauxModel([{ error: "HTTP 503：服务器太忙" }, { error: "HTTP 502：网关错误" }, { text: "终于成功了" }]);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.inMemory("/p"), {
		retry: { baseDelayMs: 5 },
	});
	const events = recordEvents(session);
	await session.prompt("你好");
	assert.deepEqual(events, ["retry_start 1/3 5ms", "retry_start 2/3 10ms", "retry_end 成功 2"]);
	assert.deepEqual(
		session.agent.state.messages.map((message) => (message.role === "assistant" ? message.stopReason : message.role)),
		["user", "stop"],
	);
	assert.equal(faux.requests[2].messages.length, 1, "重试时发给模型的对话里没有失败的回复");
});

test("超过最多的重试次数：放弃，错误留在对话里", async () => {
	const faux = createFauxModel([{ error: "HTTP 503：a" }, { error: "HTTP 503：b" }, { error: "HTTP 503：c" }]);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.inMemory("/p"), {
		retry: { baseDelayMs: 1, maxRetries: 2 },
	});
	const events = recordEvents(session);
	await session.prompt("你好");
	assert.deepEqual(events, ["retry_start 1/2 1ms", "retry_start 2/2 2ms", "retry_end 失败 2"]);
	assert.equal(faux.remaining, 0);
	const last = session.agent.state.messages.at(-1);
	assert.equal(last?.role === "assistant" && last.errorMessage, "HTTP 503：c");
});

test("不值得重试的错误、关掉了重试：都不会重试", async () => {
	const auth = createFauxModel([{ error: "HTTP 401：无效的 API key" }, { text: "不应该用到" }]);
	await new AgentSession(new Agent({ model: auth.model }), SessionManager.inMemory("/p")).prompt("你好");
	assert.equal(auth.remaining, 1);

	const busy = createFauxModel([{ error: "HTTP 503：太忙" }, { text: "不应该用到" }]);
	const session = new AgentSession(new Agent({ model: busy.model }), SessionManager.inMemory("/p"), {
		retry: { enabled: false },
	});
	await session.prompt("你好");
	assert.equal(busy.remaining, 1);
});

test("等待重试时调用 abort()：取消重试", async () => {
	const faux = createFauxModel([{ error: "HTTP 503：太忙" }, { text: "不应该用到" }]);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.inMemory("/p"), {
		retry: { baseDelayMs: 10_000 },
	});
	const events = recordEvents(session);
	session.subscribe((event) => {
		if (event.type === "retry_start") setTimeout(() => session.abort(), 10);
	});
	await session.prompt("你好");
	assert.deepEqual(events, ["retry_start 1/3 10000ms", "retry_end 失败 1"]);
	assert.equal(faux.remaining, 1);
});

test("上下文太长：压缩一次，然后重新请求", async () => {
	const long = "很长的内容。".repeat(400);
	const faux = createFauxModel(
		[
			{ text: long },
			{ text: long },
			{ error: "HTTP 400：prompt is too long" },
			{ text: "## 目标\n- 测试" }, // 压缩用的总结
			{ text: "压缩之后成功了" },
		],
		{ contextWindow: 100_000 },
	);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.inMemory("/p"), {
		compaction: { keepRecentTokens: 100 },
	});
	const events = recordEvents(session);
	await session.prompt("第一个问题");
	await session.prompt("第二个问题");
	await session.prompt("第三个问题");
	assert.deepEqual(events, ["compaction_start overflow"]);
	const last = session.agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant" && last.content[0].type === "text" && last.content[0].text === "压缩之后成功了");
	assert.equal(faux.remaining, 0);
});
