import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, Message } from "../src/ai/index.ts";
import { getSessionDir, SessionManager } from "../src/core/session.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "faux",
	provider: "faux",
	model: "m",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});
const lines = (file: string) =>
	readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

test("会话文件夹：路径里的 / 换成 -，前后加 --", () => {
	assert.equal(getSessionDir("/home/me/.mini-pi", "/home/me/todo-app"), "/home/me/.mini-pi/sessions/--home-me-todo-app--");
});

test("有了第一条消息才创建文件；之后每条记录追加一行", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.create("/project", dir);
	session.appendModelChange("deepseek", "deepseek-chat");
	assert.ok(session.sessionFile);
	assert.equal(existsSync(session.sessionFile), false, "只有设置，还没有对话：不创建文件");

	session.appendMessage(user("你好"));
	session.appendMessage(assistant("你好！"));
	const entries = lines(session.sessionFile);
	assert.deepEqual(
		entries.map((entry) => entry.type),
		["session", "model_change", "message", "message"],
	);
	assert.equal(entries[0].cwd, "/project");
	assert.equal(entries[0].id, session.sessionId);
	assert.equal(entries[2].parentId, entries[1].id, "每条记录指向上一条");
	assert.equal(entries[3].parentId, entries[2].id);
});

test("重新打开：恢复消息和模型", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.create("/project", dir);
	session.appendModelChange("deepseek", "deepseek-chat");
	session.appendMessage(user("第一个问题"));
	session.appendMessage(assistant("第一个回答"));
	session.appendModelChange("anthropic", "claude-sonnet-5-5");

	const reopened = SessionManager.open(session.sessionFile as string);
	const context = reopened.buildContext();
	assert.equal(context.messages.length, 2);
	assert.deepEqual(context.model, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "最后一次选择的模型");
	assert.equal(reopened.cwd, "/project");

	// 接着写：追加到同一个文件
	reopened.appendMessage(user("第二个问题"));
	assert.equal(lines(session.sessionFile as string).length, 6);
});

test("continueRecent：打开最近的会话；没有的话新建", async (t) => {
	const dir = await makeTempDir(t);
	assert.equal(SessionManager.continueRecent("/p", dir).buildContext().messages.length, 0);

	const older = SessionManager.create("/p", dir);
	older.appendMessage(user("旧的"));
	await new Promise((resolve) => setTimeout(resolve, 20)); // 让两个文件的修改时间不同
	const newer = SessionManager.create("/p", dir);
	newer.appendMessage(user("新的"));

	const recent = SessionManager.continueRecent("/p", dir);
	assert.equal(recent.sessionId, newer.sessionId);
});

test("列出会话：第一条用户消息当标题，最近的在前面；按 id 前缀查找", async (t) => {
	const dir = await makeTempDir(t);
	const a = SessionManager.create("/p", dir);
	a.appendMessage(user("重构登录模块"));
	a.appendMessage(assistant("好的"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const b = SessionManager.create("/p", dir);
	b.appendMessage(user("修复测试"));

	const sessions = SessionManager.list(dir);
	assert.deepEqual(
		sessions.map((session) => [session.firstMessage, session.messageCount]),
		[
			["修复测试", 1],
			["重构登录模块", 2],
		],
	);
	assert.equal(SessionManager.findById(dir, a.sessionId.slice(0, 6)), a.sessionFile);
	assert.deepEqual(SessionManager.list(join(dir, "不存在")), []);
});

test("最后一行只写了一半（程序崩溃）：跳过它，其余照常恢复", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.create("/p", dir);
	session.appendMessage(user("完整的消息"));
	appendFileSync(session.sessionFile as string, '{"type":"message","id":"abc","parentId":');
	assert.equal(SessionManager.open(session.sessionFile as string).buildContext().messages.length, 1);
});

test("branch：回到之前的某条记录，新的消息从那里长出新的分支，旧的记录不会被删除", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.create("/p", dir);
	const q1 = session.appendMessage(user("问题 1"));
	const a1 = session.appendMessage(assistant("回答 1"));
	session.appendMessage(user("问题 2（问错了）"));
	session.appendMessage(assistant("回答 2"));

	session.branch(a1); // 回到"回答 1"之后
	session.appendMessage(user("问题 2（重新问）"));
	const texts = session.buildContext().messages.map((m) => (m.role === "user" ? m.content : "回答"));
	assert.deepEqual(texts, ["问题 1", "回答", "问题 2（重新问）"]);
	assert.equal(session.getEntries().length, 5, "问错的那两条还在文件里");
	assert.equal(session.getEntries()[0].id, q1);

	// 重新打开文件：当前位置是最后写下的那条记录
	const reopened = SessionManager.open(session.sessionFile as string);
	assert.equal(reopened.buildContext().messages.length, 3);
});

test("不保存的会话：不创建任何文件", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.inMemory(dir);
	session.appendMessage(user("你好"));
	assert.equal(session.sessionFile, undefined);
	assert.deepEqual(readdirSync(dir), []);
	assert.equal(session.buildContext().messages.length, 1);
});

test("newSession：换一个新的文件，之前的记录清空", async (t) => {
	const dir = await makeTempDir(t);
	const session = SessionManager.create("/p", dir);
	session.appendMessage(user("旧会话"));
	const oldFile = session.sessionFile;
	session.newSession();
	session.appendMessage(user("新会话"));
	assert.notEqual(session.sessionFile, oldFile);
	assert.equal(session.buildContext().messages.length, 1);
	assert.equal(SessionManager.list(dir).length, 2);
});
