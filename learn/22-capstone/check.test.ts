// 毕业项目的验收测试：像用户一样从命令行运行你的 mini-pi，配合假模型服务器，检查它的行为。
// 只依赖 README 里的"接口规范"，不关心你的代码怎么组织。
//
// 运行（在仓库根目录）：
//   node --test learn/22-capstone/check.test.ts                      检查参考答案（里程碑 20）
//   MY_PI=~/my-pi node --test learn/22-capstone/check.test.ts        检查你自己的项目
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectDir, runNode } from "../tools/check-helpers.ts";
import { type FakeLlmServer, type FakeReply, startFakeLlm } from "../tools/fake-llm/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** 没有设置 MY_PI 时，检查里程碑 20 的参考答案 */
const project = process.env.MY_PI ? projectDir(here) : join(here, "..", "20-polish", "code");
const CLI = join(project, "src", "cli.ts");

interface Setup {
	/** 项目目录：mini-pi 在这里运行 */
	dir: string;
	/** mini-pi 的数据目录（MINI_PI_DIR） */
	dataDir: string;
	server: FakeLlmServer;
	/** 运行 mini-pi，自动带上连接假模型需要的参数和环境变量 */
	run(args: string[], options?: { input?: string; env?: Record<string, string> }): ReturnType<typeof runNode>;
}

async function setup(
	t: TestContext,
	script: FakeReply[],
	options: { protocol?: "openai" | "anthropic"; chop?: boolean } = {},
): Promise<Setup> {
	// realpath：macOS 的临时目录是符号链接，mini-pi 里 process.cwd() 返回的是真实的路径
	const dir = await realpath(await mkdtemp(join(tmpdir(), "capstone-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const dataDir = join(dir, ".mini-pi-data");
	const server = await startFakeLlm({ port: 0, delayMs: 0, script, chop: options.chop });
	t.after(() => server.close());
	const anthropic = options.protocol === "anthropic";
	const env = {
		LLM_BASE_URL: anthropic ? server.url : `${server.url}/v1`,
		LLM_API_KEY: "test-key",
		...(anthropic ? { LLM_API: "anthropic-messages" } : {}),
		MINI_PI_DIR: dataDir,
		HOME: dir,
	};
	return {
		dir,
		dataDir,
		server,
		run: (args, runOptions = {}) =>
			runNode(dir, CLI, ["--model", "custom/test-model", ...args], { ...env, ...runOptions.env }, { input: runOptions.input }),
	};
}

/** 第 index 个请求里的工具结果（按顺序） */
function toolResults(server: FakeLlmServer, index: number) {
	return server.requests[index].normalized.messages.filter((message) => message.role === "tool");
}

// ---------- 命令行 ----------

test("--version 输出版本号，--help 输出用法", async (t) => {
	const { run } = await setup(t, []);
	const version = await run(["--version"]);
	assert.equal(version.code, 0);
	assert.match(version.stdout, /\d+\.\d+\.\d+/);
	const help = await run(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /--model/);
	assert.match(help.stdout, /-p/);
});

test("不认识的选项：退出码 1，stderr 里有说明", async (t) => {
	const { run } = await setup(t, []);
	const result = await run(["--no-such-option"]);
	assert.equal(result.code, 1);
	assert.notEqual(result.stderr.trim(), "");
});

// ---------- print 模式和流式输出 ----------

test("print 模式：只输出最终的回答，退出码 0", async (t) => {
	const { run } = await setup(t, [{ thinking: "让我想想", text: "你好，我是 mini-pi。" }]);
	const result = await run(["-p", "你是谁"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "你好，我是 mini-pi。");
	assert.doesNotMatch(result.stdout, /让我想想/, "思考过程不输出");
});

test("流式响应被切成随机的碎片（连汉字都切开）也能正确拼起来", async (t) => {
	const text = "这是一段比较长的回答，用来检验 SSE 解析器：它要能处理被拆开的行、被拆开的汉字，以及一次送来的好几个事件。";
	const { run } = await setup(t, [{ text }], { chop: true });
	const result = await run(["-p", "你好"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), text);
});

test("Anthropic 协议（LLM_API=anthropic-messages）", async (t) => {
	const { run, server } = await setup(t, [{ text: "来自 Anthropic 协议的回答" }], { protocol: "anthropic" });
	const result = await run(["-p", "你好"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "来自 Anthropic 协议的回答");
	assert.equal(server.requests[0].api, "anthropic");
});

test("模型返回错误（不可重试的）：stderr 里有错误信息，退出码 1", async (t) => {
	const { run, server } = await setup(t, [
		{ error: { status: 401, message: "Invalid API key" } },
		{ text: "不应该用到" },
	]);
	const result = await run(["-p", "你好"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /401|Invalid API key/);
	assert.equal(server.requests.length, 1, "认证失败不重试");
});

// ---------- 系统提示词 ----------

test("系统提示词里有工作目录、工具，以及全局和项目的 AGENTS.md（全局的在前）", async (t) => {
	const { run, server, dir, dataDir } = await setup(t, [{ text: "好" }]);
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "AGENTS.md"), "全局规则：总是用中文回答");
	await writeFile(join(dir, "AGENTS.md"), "项目规则：测试命令是 npm test");
	await run(["-p", "你好"]);
	const system = server.requests[0].normalized.system;
	assert.ok(system.includes(dir), "包含工作目录");
	assert.match(system, /全局规则：总是用中文回答[\s\S]*项目规则：测试命令是 npm test/);
	assert.match(system, /read[\s\S]*bash|bash[\s\S]*read/, "提到了工具");
});

test("请求里带着五个工具的定义，参数名符合规范", async (t) => {
	const { run, server } = await setup(t, [{ text: "好" }]);
	await run(["-p", "你好"]);
	const tools = Object.fromEntries(server.requests[0].normalized.tools.map((tool) => [tool.name, tool.properties]));
	assert.deepEqual(Object.keys(tools).sort(), ["bash", "edit", "ls", "read", "write"]);
	assert.ok(tools.read.includes("path") && tools.read.includes("offset") && tools.read.includes("limit"));
	assert.ok(tools.write.includes("path") && tools.write.includes("content"));
	assert.ok(tools.edit.includes("path") && tools.edit.includes("edits"));
	assert.ok(tools.bash.includes("command"));
	assert.ok(tools.ls.includes("path"));
});

test("--tools 只启用部分工具，--no-tools 不启用任何工具", async (t) => {
	const { run, server } = await setup(t, [{ text: "好" }, { text: "好" }]);
	await run(["--tools", "read,ls", "-p", "你好"]);
	assert.deepEqual(server.requests[0].normalized.tools.map((tool) => tool.name).sort(), ["ls", "read"]);
	await run(["--no-tools", "-p", "你好"]);
	assert.deepEqual(server.requests[1].normalized.tools, []);
});

// ---------- 工具 ----------

test("write：创建文件（包括不存在的目录），然后给出回答", async (t) => {
	const { run, dir } = await setup(t, [
		{ toolCalls: [{ name: "write", arguments: { path: "src/deep/hello.txt", content: "你好\n世界\n" } }] },
		{ text: "写好了" },
	]);
	const result = await run(["-p", "创建文件"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "写好了");
	assert.equal(await readFile(join(dir, "src/deep/hello.txt"), "utf-8"), "你好\n世界\n");
});

test("read：读取文件；offset 和 limit 读取一部分", async (t) => {
	const { run, server, dir } = await setup(t, [
		{ toolCalls: [{ name: "read", arguments: { path: "notes.txt" } }] },
		{ toolCalls: [{ name: "read", arguments: { path: "notes.txt", offset: 2, limit: 2 } }] },
		{ text: "读完了" },
	]);
	await writeFile(join(dir, "notes.txt"), "第一行\n第二行\n第三行\n第四行\n");
	const result = await run(["-p", "读文件"]);
	assert.equal(result.code, 0, result.stderr);
	const [whole] = toolResults(server, 1);
	assert.match(whole.text, /第一行[\s\S]*第四行/);
	const part = toolResults(server, 2)[1];
	assert.match(part.text, /第二行[\s\S]*第三行/);
	assert.doesNotMatch(part.text, /第一行|第四行/);
});

test("read：大文件只返回一部分，并提示怎样继续读", async (t) => {
	const { run, server, dir } = await setup(t, [
		{ toolCalls: [{ name: "read", arguments: { path: "big.txt" } }] },
		{ text: "好" },
	]);
	await writeFile(join(dir, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
	await run(["-p", "读大文件"]);
	const [result] = toolResults(server, 1);
	assert.ok(result.text.split("\n").length <= 2010, "最多 2000 行左右");
	assert.match(result.text, /line 1\n/);
	assert.doesNotMatch(result.text, /line 5000/);
	assert.match(result.text, /offset/, "提示用 offset 继续读");
});

test("edit：替换唯一的一处文字", async (t) => {
	const { run, dir } = await setup(t, [
		{ toolCalls: [{ name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "return a - b;", newText: "return a + b;" }] } }] },
		{ text: "改好了" },
	]);
	await writeFile(join(dir, "a.ts"), "export function add(a, b) {\n\treturn a - b;\n}\n");
	const result = await run(["-p", "修复"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(join(dir, "a.ts"), "utf-8"), "export function add(a, b) {\n\treturn a + b;\n}\n");
});

test("edit：找不到要替换的文字时，文件不变，错误作为工具结果告诉模型，agent 继续运行", async (t) => {
	const { run, server, dir } = await setup(t, [
		{ toolCalls: [{ name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "不存在的内容", newText: "x" }] } }] },
		{ text: "我换个办法" },
	]);
	await writeFile(join(dir, "a.ts"), "const a = 1;\n");
	const result = await run(["-p", "修改"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "我换个办法");
	assert.equal(await readFile(join(dir, "a.ts"), "utf-8"), "const a = 1;\n");
	const [toolResult] = toolResults(server, 1);
	assert.ok(toolResult.text.includes("a.ts"), "错误信息里提到了文件");
});

test("edit：要替换的文字出现了不止一次时，报错，文件不变", async (t) => {
	const { run, server, dir } = await setup(t, [
		{ toolCalls: [{ name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }] },
		{ text: "好" },
	]);
	await writeFile(join(dir, "a.ts"), "x\nx\n");
	await run(["-p", "修改"]);
	assert.equal(await readFile(join(dir, "a.ts"), "utf-8"), "x\nx\n");
	assert.notEqual(toolResults(server, 1)[0].text.trim(), "");
});

test("bash：返回命令的输出；退出码不是 0 时，结果里说明退出码", async (t) => {
	const { run, server } = await setup(t, [
		{ toolCalls: [{ name: "bash", arguments: { command: "echo 你好 && echo 错误 >&2" } }] },
		{ toolCalls: [{ name: "bash", arguments: { command: "echo 坏了; exit 3" } }] },
		{ text: "好" },
	]);
	await run(["-p", "运行命令"]);
	const [ok] = toolResults(server, 1);
	assert.match(ok.text, /你好/);
	assert.match(ok.text, /错误/, "stderr 也要返回");
	const failed = toolResults(server, 2)[1];
	assert.match(failed.text, /坏了/);
	assert.match(failed.text, /3/, "说明了退出码");
});

test("bash：输出太长时只保留最后的部分", async (t) => {
	const { run, server } = await setup(t, [{ toolCalls: [{ name: "bash", arguments: { command: "seq 1 100000" } }] }, { text: "好" }]);
	await run(["-p", "运行命令"]);
	const [result] = toolResults(server, 1);
	assert.ok(result.text.length < 60_000, `结果太长：${result.text.length} 个字符`);
	assert.match(result.text, /100000/, "保留了最后的输出");
	assert.doesNotMatch(result.text, /^1\n2\n3\n/, "开头的部分被截掉了");
});

test("ls：列出文件和目录，目录后面带 /", async (t) => {
	const { run, server, dir } = await setup(t, [{ toolCalls: [{ name: "ls", arguments: { path: "." } }] }, { text: "好" }]);
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "package.json"), "{}");
	await run(["-p", "看看目录"]);
	const [result] = toolResults(server, 1);
	assert.match(result.text, /src\//);
	assert.match(result.text, /package\.json/);
});

test("一次回复里调用两个工具：都执行，结果按调用的顺序返回", async (t) => {
	const { run, server, dir } = await setup(t, [
		{
			toolCalls: [
				{ id: "call_a", name: "write", arguments: { path: "a.txt", content: "A" } },
				{ id: "call_b", name: "write", arguments: { path: "b.txt", content: "B" } },
			],
		},
		{ text: "两个都写好了" },
	]);
	const result = await run(["-p", "写两个文件"]);
	assert.equal(result.stdout.trim(), "两个都写好了");
	assert.ok(existsSync(join(dir, "a.txt")) && existsSync(join(dir, "b.txt")));
	const ids = server.requests[1].body.messages
		.filter((message: { role: string }) => message.role === "tool")
		.map((message: { tool_call_id: string }) => message.tool_call_id);
	assert.deepEqual(ids, ["call_a", "call_b"]);
});

test("参数不对（缺少必填参数）、不存在的工具：错误告诉模型，程序不会崩溃", async (t) => {
	const { run, server } = await setup(t, [
		{ toolCalls: [{ name: "write", arguments: { path: "a.txt" } }] },
		{ toolCalls: [{ name: "no_such_tool", arguments: {} }] },
		{ text: "好的" },
	]);
	const result = await run(["-p", "试试"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "好的");
	assert.match(toolResults(server, 1)[0].text, /content/, "说明缺少 content");
	assert.match(toolResults(server, 2)[1].text, /no_such_tool/);
});

// ---------- 输入 ----------

test("管道输入和 @文件 的内容会附加到消息里", async (t) => {
	const { run, server, dir } = await setup(t, [{ text: "好" }]);
	await writeFile(join(dir, "error.log"), "TypeError: x is undefined");
	await run(["-p", "@error.log", "解释一下"], { input: "这是管道送来的内容" });
	const user = server.requests[0].normalized.messages[0];
	assert.match(user.text, /这是管道送来的内容/);
	assert.match(user.text, /TypeError: x is undefined/);
	assert.match(user.text, /解释一下/);
});

// ---------- 会话 ----------

test("会话：默认保存；-c 继续上一次的对话；--no-session 不保存", async (t) => {
	const { run, server, dataDir } = await setup(t, [{ text: "记住了，你叫小明" }, { text: "你叫小明" }, { text: "好" }]);
	await run(["-p", "我叫小明"]);
	const sessionFiles = () => readdirSync(dataDir, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
	assert.equal(sessionFiles().length, 1, "保存了一个会话文件");

	await run(["-c", "-p", "我叫什么"]);
	const texts = server.requests[1].normalized.messages.map((message) => message.text);
	assert.ok(texts.some((text) => text.includes("我叫小明")), "继续的会话里有上一次的对话");
	assert.equal(sessionFiles().length, 1, "继续时写进同一个文件");

	await run(["--no-session", "-p", "随便聊聊"]);
	assert.equal(sessionFiles().length, 1, "--no-session 不创建新的会话文件");
});

// ---------- 自动重试 ----------

test("服务器返回 503：自动重试，成功后照常输出（重试的等待时间来自设置文件）", async (t) => {
	const { run, server, dataDir } = await setup(t, [
		{ error: { status: 503, message: "The server is overloaded" } },
		{ error: { status: 429, message: "Rate limit exceeded" } },
		{ text: "重试之后成功了" },
	]);
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 10 } }));
	const result = await run(["-p", "你好"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "重试之后成功了");
	assert.equal(server.requests.length, 3);
});
