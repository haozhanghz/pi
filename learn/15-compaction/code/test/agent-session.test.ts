import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Agent, type AgentTool } from "../src/agent/index.ts";
import { createFauxModel } from "../src/ai/index.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const echo: AgentTool<{ text: string }> = {
	name: "echo",
	description: "原样返回",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	async execute(_id, { text }) {
		return { content: [{ type: "text", text }] };
	},
};

test("每条消息完成时都保存到文件里，包括工具调用和结果", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { text: "hi" } }] }, { text: "完成" }]);
	const session = new AgentSession(new Agent({ model: faux.model, tools: [echo] }), SessionManager.create("/p", dir));
	await session.prompt("试试");

	const entries = readFileSync(session.sessionManager.sessionFile as string, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		entries.map((entry) => entry.message?.role ?? entry.type),
		["session", "model_change", "user", "assistant", "toolResult", "assistant"],
	);
});

test("恢复会话：agent 拿回之前的对话，模型能看到它们", async (t) => {
	const dir = await makeTempDir(t);
	const first = createFauxModel([{ text: "记住了，你叫小明" }]);
	const session1 = new AgentSession(new Agent({ model: first.model }), SessionManager.create("/p", dir));
	await session1.prompt("我叫小明");

	// 模拟"关掉程序、明天再打开"：新的 Agent，新的 SessionManager，打开同一个文件
	const second = createFauxModel([{ text: "你叫小明" }]);
	const session2 = new AgentSession(
		new Agent({ model: second.model }),
		SessionManager.open(session1.sessionManager.sessionFile as string),
	);
	assert.equal(session2.agent.state.messages.length, 2);
	await session2.prompt("我叫什么？");
	assert.equal(second.requests[0].messages.length, 3, "第二天的请求里有昨天的两条消息");
});

test("换模型时记录 model_change；新会话写进新文件", async (t) => {
	const dir = await makeTempDir(t);
	const a = createFauxModel([{ text: "1" }]);
	const b = createFauxModel([{ text: "2" }]);
	const session = new AgentSession(new Agent({ model: a.model }), SessionManager.create("/p", dir));
	await session.prompt("x");
	session.setModel(b.model);
	assert.deepEqual(session.sessionManager.buildContext().model, { provider: b.model.provider, modelId: b.model.id });

	const oldFile = session.sessionManager.sessionFile;
	session.newSession();
	assert.equal(session.agent.state.messages.length, 0);
	await session.prompt("y");
	assert.notEqual(session.sessionManager.sessionFile, oldFile);
});

test("统计：问题数、工具调用数、token", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ toolCalls: [{ name: "echo", arguments: { text: "a" } }] }, { text: "好" }]);
	const session = new AgentSession(new Agent({ model: faux.model, tools: [echo] }), SessionManager.create("/p", dir));
	await session.prompt("x");
	const stats = session.getStats();
	assert.equal(stats.userMessages, 1);
	assert.equal(stats.assistantMessages, 2);
	assert.equal(stats.toolCalls, 1);
	assert.ok(stats.tokens > 0);
});

// ---------- 里程碑 15：上下文压缩 ----------

/** 一段大约 100 个 token 的文字（400 个字符） */
const big = (char: string) => char.repeat(400);

test("手动压缩：旧的消息变成总结，最近的消息保留原文，下次请求用压缩后的上下文", async (t) => {
	const dir = await makeTempDir(t);
	// 上下文窗口只有 400：保留最近的 100 个 token，预留 100 个 token
	const faux = createFauxModel([{ text: big("a") }, { text: big("b") }, { text: "## 目标\n- 测试压缩" }, { text: "好" }], {
		contextWindow: 400,
	});
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir), {
		compaction: { enabled: false }, // 关掉自动压缩，手动来
	});
	await session.prompt(big("1"));
	await session.prompt(big("2"));

	const events: string[] = [];
	session.subscribe((event) => void events.push(event.type));
	const result = await session.compact();
	assert.ok(result);
	assert.equal(result.summarizedMessages, 3, "问题 1、回答 1、问题 2 被总结了，回答 2 保留");
	assert.ok(result.tokensAfter < result.tokensBefore);
	assert.deepEqual(events, ["compaction_start", "compaction_end"]);

	const messages = session.agent.state.messages;
	assert.ok(messages[0].role === "user" && messages[0].content.includes("## 目标\n- 测试压缩"));
	assert.equal(messages.length, 2);

	await session.prompt("继续");
	const lastRequest = faux.requests.at(-1);
	assert.equal(lastRequest?.messages.length, 3, "总结、保留的回答 2、新的问题");
});

test("对话还很短时，没有可以压缩的内容", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ text: "好" }]);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir));
	await session.prompt("hi");
	assert.equal(await session.compact(), undefined);
});

test("自动压缩：发送新问题之前，上下文超过了阈值", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ text: big("a") }, { text: big("b") }, { text: "## 目标\n- 自动" }, { text: "好" }], {
		contextWindow: 400,
	});
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir));
	const reasons: string[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_start") reasons.push(event.reason);
	});
	await session.prompt(big("1"));
	await session.prompt(big("2"));
	assert.deepEqual(reasons, [], "到这里还没有超过阈值");
	await session.prompt("第三个问题");
	assert.deepEqual(reasons, ["threshold"]);
	assert.match(faux.requests[2].systemPrompt ?? "", /上下文总结助手/, "第三次请求是在生成总结");
	const firstMessage = faux.requests[3].messages[0];
	assert.ok(firstMessage.role === "user" && firstMessage.content.includes("## 目标\n- 自动"));
});

test("一次运行中途上下文满了：在两轮之间压缩，工具调用和它的结果不会被拆开", async (t) => {
	const dir = await makeTempDir(t);
	const bigTool: AgentTool = {
		name: "big",
		description: "返回很多内容",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: big("x") }] };
		},
	};
	const faux = createFauxModel(
		[
			{ toolCalls: [{ name: "big", arguments: {} }] },
			{ toolCalls: [{ name: "big", arguments: {} }] },
			{ toolCalls: [{ name: "big", arguments: {} }] },
			{ text: "## 目标\n- 中途压缩" },
			{ text: "全部完成" },
		],
		{ contextWindow: 400 },
	);
	const session = new AgentSession(new Agent({ model: faux.model, tools: [bigTool] }), SessionManager.create("/p", dir));
	await session.prompt("开始");

	assert.match(faux.requests[3].systemPrompt ?? "", /上下文总结助手/);
	const final = faux.requests[4].messages;
	assert.deepEqual(
		final.map((m) => m.role),
		["user", "assistant", "toolResult"],
		"总结，然后是最后一次工具调用和它的结果",
	);
	assert.equal(session.agent.state.messages.at(-1)?.role, "assistant");
});

test("压缩之后不会马上又压缩（压缩前的用量数据不再使用）", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel(
		[{ text: big("a") }, { text: big("b") }, { text: "总结" }, { text: "好" }, { text: "又好" }],
		{ contextWindow: 400 },
	);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir));
	let compactions = 0;
	session.subscribe((event) => {
		if (event.type === "compaction_start") compactions++;
	});
	await session.prompt(big("1"));
	await session.prompt(big("2"));
	await session.prompt("三");
	await session.prompt("四");
	assert.equal(compactions, 1);
});

test("自动压缩失败：报告错误，但用户的问题照常发送", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ text: big("a") }, { text: big("b") }, { error: "总结服务挂了" }, { text: "照常回答" }], {
		contextWindow: 400,
	});
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir));
	const errors: string[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_end" && event.error) errors.push(event.error);
	});
	await session.prompt(big("1"));
	await session.prompt(big("2"));
	await session.prompt("三");
	assert.match(errors[0], /总结服务挂了/);
	const last = session.agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant" && last.content[0].type === "text" && last.content[0].text === "照常回答");
});

test("恢复一个压缩过的会话：从总结开始", async (t) => {
	const dir = await makeTempDir(t);
	const faux = createFauxModel([{ text: big("a") }, { text: big("b") }, { text: "## 目标\n- 恢复" }], { contextWindow: 400 });
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.create("/p", dir), {
		compaction: { enabled: false },
	});
	await session.prompt(big("1"));
	await session.prompt(big("2"));
	await session.compact();

	const restored = new AgentSession(
		new Agent({ model: faux.model }),
		SessionManager.open(session.sessionManager.sessionFile as string),
	);
	const first = restored.agent.state.messages[0];
	assert.ok(first.role === "user" && first.content.includes("## 目标\n- 恢复"));
	assert.equal(restored.getStats().userMessages, 2, "统计的是完整的历史，不受压缩影响");
});
