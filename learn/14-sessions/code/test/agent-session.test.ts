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
