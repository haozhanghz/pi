import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { finishChunk, startFakeServer, textChunk, toolCallChunk, type FakeResponse } from "./helpers/fake-server.ts";
import { runCli } from "./helpers/run-cli.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

/** 准备一个项目目录、一个假的模型服务器，返回运行 mini-pi 需要的环境变量 */
async function setup(t: TestContext, responses: FakeResponse[]) {
	const dir = await makeTempDir(t);
	const server = await startFakeServer(responses);
	t.after(() => server.close());
	const env = { LLM_BASE_URL: server.url, MINI_PI_DIR: join(dir, ".mini-pi") };
	return { dir, server, env };
}

const MODEL = ["--model", "custom/test-model"];

test("print 模式：输出最终回答，退出码 0", async (t) => {
	const { dir, env } = await setup(t, [{ chunks: [textChunk("你好，"), textChunk("我是 mini-pi"), finishChunk("stop")] }]);
	const result = await runCli([...MODEL, "-p", "你是谁"], { cwd: dir, env });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "你好，我是 mini-pi\n");
});

test("调用工具：在当前目录里写文件，再给出回答", async (t) => {
	const { dir, env, server } = await setup(t, [
		{
			chunks: [
				toolCallChunk(0, { id: "call_1", name: "write", args: '{"path":"hello.txt","content":"你好"}' }),
				finishChunk("tool_calls"),
			],
		},
		{ chunks: [textChunk("写好了"), finishChunk("stop")] },
	]);
	const result = await runCli([...MODEL, "-p", "创建 hello.txt"], { cwd: dir, env });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "写好了\n");
	assert.equal(await readFile(join(dir, "hello.txt"), "utf-8"), "你好");
	assert.equal(server.requests.length, 2);
});

test("系统提示词里有工具列表、项目说明（AGENTS.md）和工作目录", async (t) => {
	const { dir, env, server } = await setup(t, [{ chunks: [textChunk("好"), finishChunk("stop")] }]);
	await writeFile(join(dir, "AGENTS.md"), "测试命令是 npm test");
	await mkdir(join(dir, ".mini-pi"), { recursive: true });
	await writeFile(join(dir, ".mini-pi", "AGENTS.md"), "总是用中文回答");
	await runCli([...MODEL, "-p", "hi"], { cwd: dir, env });

	const system = server.requests[0].body.messages[0];
	assert.equal(system.role, "system");
	assert.match(system.content, /- read: 读取文件内容/);
	assert.match(system.content, /总是用中文回答[\s\S]*测试命令是 npm test/, "全局的说明在前，项目的在后");
	assert.ok(system.content.includes(`<cwd>\n${dir}\n</cwd>`));
});

test("--tools 只启用部分工具；--system-prompt 替换默认提示词", async (t) => {
	const { dir, env, server } = await setup(t, [{ chunks: [textChunk("好"), finishChunk("stop")] }]);
	await runCli([...MODEL, "-p", "--tools", "read,ls", "--system-prompt", "你是一只猫", "hi"], { cwd: dir, env });
	const body = server.requests[0].body;
	assert.deepEqual(
		body.tools.map((tool: { function: { name: string } }) => tool.function.name),
		["read", "ls"],
	);
	assert.ok(body.messages[0].content.startsWith("你是一只猫"));
});

test("管道输入和 @文件 的内容都附加到消息里", async (t) => {
	const { dir, env, server } = await setup(t, [{ chunks: [textChunk("看到了"), finishChunk("stop")] }]);
	await writeFile(join(dir, "a.txt"), "文件内容");
	const result = await runCli([...MODEL, "@a.txt", "解释一下"], { cwd: dir, env, input: "错误日志：xxx" });
	assert.equal(result.code, 0, result.stderr);
	const user = server.requests[0].body.messages.at(-1).content;
	assert.ok(user.startsWith("错误日志：xxx\n"));
	assert.ok(user.includes(`<file name="${join(dir, "a.txt")}">\n文件内容\n</file>`));
	assert.ok(user.endsWith("解释一下"));
});

test("模型出错：错误信息写到标准错误，退出码 1", async (t) => {
	const { dir, env } = await setup(t, [{ status: 401, body: '{"error":{"message":"API key 不对"}}' }]);
	const result = await runCli([...MODEL, "-p", "hi"], { cwd: dir, env });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /API key 不对/);
	assert.equal(result.stdout, "");
});

test("--mode json：每行一个事件", async (t) => {
	const { dir, env } = await setup(t, [{ chunks: [textChunk("好"), finishChunk("stop")] }]);
	const result = await runCli([...MODEL, "--mode", "json", "hi"], { cwd: dir, env });
	const events = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(events[0].type, "agent_start");
	assert.equal(events.at(-1).type, "agent_end");
	assert.ok(events.some((event) => event.type === "message_update"));
});

test("--help、--version、没有消息时报错", async (t) => {
	const dir = await makeTempDir(t);
	assert.match((await runCli(["--help"], { cwd: dir })).stdout, /用法：/);
	assert.match((await runCli(["--version"], { cwd: dir })).stdout, /^\d+\.\d+\.\d+\n$/);
	const noMessage = await runCli(["-p"], { cwd: dir });
	assert.equal(noMessage.code, 1);
	assert.match(noMessage.stderr, /print 模式需要一条消息/);
});
