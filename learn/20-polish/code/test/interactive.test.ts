import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentTool } from "../src/agent/index.ts";
import { createFauxModel, type FauxStep } from "../src/ai/index.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session.ts";
import { runInteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

/** 每隔一会儿检查一次，直到条件成立（或者超时） */
async function waitFor(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${message}`);
		await sleep(10);
	}
}

/** 一个假的 bash 工具：记录收到的命令，不真的执行 */
function fakeBash(commands: string[], delayMs = 0): AgentTool<{ command: string }> {
	return {
		name: "bash",
		description: "执行命令",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		async execute(_id, { command }) {
			commands.push(command);
			await sleep(delayMs);
			return { content: [{ type: "text", text: `执行了 ${command}\n第二行输出` }] };
		},
	};
}

function setup(steps: FauxStep[], tools: AgentTool[] = [], sessionManager = SessionManager.inMemory("/project")) {
	const faux = createFauxModel(steps);
	const session = new AgentSession(new Agent({ model: faux.model, tools }), sessionManager);
	const terminal = new VirtualTerminal(60, 30);
	const done = runInteractiveMode(session, { terminal, cwd: "/project" });
	/** 用户往回滚动能看到的全部内容 */
	const screen = () => terminal.getAllLines().join("\n");
	return { faux, session, terminal, done, screen };
}

test("发送一条消息：显示用户的消息和回答，Ctrl+D 退出", async () => {
	const { terminal, done, screen } = setup([{ text: "你好！我是 **mini-pi**。" }]);
	terminal.send("你好\r");
	await waitFor(() => screen().includes("你好！我是 mini-pi。"), "回答");
	assert.match(screen(), /> 你好/);
	assert.match(screen(), /faux-\d+ · ↑\d+ ↓\d+/, "状态栏显示模型和 token");
	terminal.send("\x04");
	await done;
	assert.equal(terminal.started, false, "退出时恢复了终端");
	assert.match(screen(), /本次会话：1 个问题/);
});

test("工具调用：显示命令和输出的预览", async () => {
	const commands: string[] = [];
	const { terminal, done, screen } = setup(
		[{ toolCalls: [{ name: "bash", arguments: { command: "npm test" } }] }, { text: "测试都通过了" }],
		[fakeBash(commands)],
	);
	terminal.send("运行测试\r");
	await waitFor(() => screen().includes("测试都通过了"), "最后的回答");
	assert.deepEqual(commands, ["npm test"]);
	assert.match(screen(), /\$ npm test\n │ 执行了 npm test\n │ 第二行输出/);
	terminal.send("\x04");
	await done;
});

test("危险的命令：弹出确认对话框，按 n 拒绝之后不会执行", async () => {
	const commands: string[] = [];
	const { faux, terminal, done, screen } = setup(
		[{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "好的，不删了" }],
		[fakeBash(commands)],
	);
	terminal.send("清理一下\r");
	await waitFor(() => screen().includes("允许执行吗"), "确认对话框");
	terminal.send("n");
	await waitFor(() => screen().includes("好的，不删了"), "拒绝之后的回答");
	assert.deepEqual(commands, [], "命令没有执行");
	const toolResult = faux.requests[1].messages.find((message) => message.role === "toolResult");
	assert.match(JSON.stringify(toolResult), /用户拒绝执行这个命令/);
	assert.doesNotMatch(terminal.getScreen().join("\n"), /允许执行吗/, "对话框消失，换回了输入框");
	terminal.send("\x04");
	await done;
});

test("Esc 打断正在输出的回答", async () => {
	const { terminal, done, screen } = setup([{ text: "这是一个很长很长的回答，".repeat(30), delayMs: 20 }]);
	terminal.send("讲个故事\r");
	await waitFor(() => screen().includes("这是一个很长"), "开始输出");
	terminal.send("\x1b");
	await waitFor(() => screen().includes("已打断"), "打断的提示");
	terminal.send("\x04");
	await done;
});

test("运行时输入的消息是插话：先显示在输入框上面，工具执行完之后发给模型", async () => {
	const commands: string[] = [];
	const { faux, terminal, done, screen } = setup(
		[{ toolCalls: [{ name: "bash", arguments: { command: "sleep" } }] }, { text: "收到，顺便看了测试" }],
		[fakeBash(commands, 300)],
	);
	terminal.send("开始\r");
	await waitFor(() => commands.length === 1, "工具开始执行");
	terminal.send("顺便看看测试\r");
	await waitFor(() => screen().includes("插话：顺便看看测试"), "排队的提示");
	await waitFor(() => screen().includes("收到，顺便看了测试"), "最后的回答");
	assert.doesNotMatch(screen(), /插话：/, "插话发出去之后，提示消失了");
	assert.match(screen(), /> 顺便看看测试/);
	const messages = faux.requests[1].messages.map((message) => message.role);
	assert.deepEqual(messages, ["user", "assistant", "toolResult", "user"]);
	terminal.send("\x04");
	await done;
});

test("Ctrl+C 清空输入，很快地再按一次退出", async () => {
	const { terminal, done } = setup([]);
	terminal.send("写了一半");
	await waitFor(() => terminal.getScreen().join("\n").includes("写了一半"), "输入的内容");
	terminal.send("\x03");
	await waitFor(() => !terminal.getScreen().join("\n").includes("写了一半"), "清空输入框");
	terminal.send("\x03");
	await done;
	assert.equal(terminal.started, false);
});

test("恢复会话：显示之前的对话，包括工具调用的结果", async () => {
	const sessionManager = SessionManager.inMemory("/project");
	const first = setup(
		[{ toolCalls: [{ name: "bash", arguments: { command: "ls" } }] }, { text: "看完了" }],
		[fakeBash([])],
		sessionManager,
	);
	first.terminal.send("看看有什么文件\r");
	await waitFor(() => first.screen().includes("看完了"), "第一次的回答");
	first.terminal.send("\x04");
	await first.done;

	const second = setup([], [fakeBash([])], sessionManager);
	await waitFor(() => second.screen().includes("看完了"), "恢复的对话");
	assert.match(second.screen(), /> 看看有什么文件[\s\S]*\$ ls\n │ 执行了 ls[\s\S]*看完了/);
	second.terminal.send("\x04");
	await second.done;
});
