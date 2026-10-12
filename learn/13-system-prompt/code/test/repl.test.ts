import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Agent, type AgentTool } from "../src/agent/index.ts";
import { createFauxModel, type ToolResultMessage } from "../src/ai/index.ts";
import { runReplMode } from "../src/modes/repl.ts";

/** 用两个内存里的流代替真正的终端：往 input 里写就是"用户打字"，从 output 里读就是"屏幕上显示的内容" */
function fakeTerminal() {
	const input = new PassThrough();
	const output = new PassThrough();
	let screen = "";
	output.on("data", (chunk: Buffer) => {
		screen += chunk.toString("utf-8");
	});
	const waitFor = async (text: string) => {
		for (let i = 0; i < 200; i++) {
			if (screen.includes(text)) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`等了 2 秒，屏幕上还没有出现"${text}"。屏幕内容：\n${screen}`);
	};
	return { input, output, waitFor, screen: () => screen };
}

/** 一个假的 bash 工具：只记录收到的命令，不真的执行 */
function fakeBash(commands: string[]): AgentTool<{ command: string }> {
	return {
		name: "bash",
		description: "执行命令",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		async execute(_id, { command }) {
			commands.push(command);
			return { content: [{ type: "text", text: "执行了" }] };
		},
	};
}

test("输入一行 → agent 回答 → 输入结束时退出", async () => {
	const faux = createFauxModel([{ text: "你好！我能帮你什么？" }]);
	const agent = new Agent({ model: faux.model });
	const terminal = fakeTerminal();
	const done = runReplMode(agent, { input: terminal.input, output: terminal.output, banner: ["mini-pi 测试版"] });
	terminal.input.write("hi\n");
	await terminal.waitFor("你好！我能帮你什么？");
	terminal.input.end(); // 相当于按 Ctrl+D
	await done;
	assert.match(terminal.screen(), /mini-pi 测试版/);
	assert.match(terminal.screen(), /再见/);
	assert.equal(agent.state.messages.length, 2);
});

test("危险命令：回答 n 就不执行，模型收到拒绝的原因", async () => {
	const commands: string[] = [];
	const faux = createFauxModel([{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "好的，不删了" }]);
	const agent = new Agent({ model: faux.model, tools: [fakeBash(commands)] });
	const terminal = fakeTerminal();
	const done = runReplMode(agent, { input: terminal.input, output: terminal.output });
	terminal.input.write("删掉 build 目录\n");
	await terminal.waitFor("允许执行吗？");
	terminal.input.write("n\n");
	await terminal.waitFor("好的，不删了");
	terminal.input.end();
	await done;
	assert.deepEqual(commands, []);
	const result = agent.state.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
	assert.equal(result?.content[0].text, "用户拒绝执行这个命令。");
});

test("危险命令：回答 y 就执行；普通命令不用确认", async () => {
	const commands: string[] = [];
	const faux = createFauxModel([
		{
			toolCalls: [
				{ name: "bash", arguments: { command: "ls" } },
				{ name: "bash", arguments: { command: "sudo reboot" } },
			],
		},
		{ text: "都执行了" },
	]);
	const agent = new Agent({ model: faux.model, tools: [fakeBash(commands)] });
	const terminal = fakeTerminal();
	const done = runReplMode(agent, { input: terminal.input, output: terminal.output });
	terminal.input.write("x\n");
	await terminal.waitFor("sudo reboot\n允许执行吗？");
	terminal.input.write("y\n");
	await terminal.waitFor("都执行了");
	terminal.input.end();
	await done;
	assert.deepEqual(commands, ["ls", "sudo reboot"]);
});

test("启动时带着消息：先发送它们", async () => {
	const faux = createFauxModel([{ text: "第一条的回答" }]);
	const agent = new Agent({ model: faux.model });
	const terminal = fakeTerminal();
	const done = runReplMode(agent, { input: terminal.input, output: terminal.output, initialMessages: ["第一条"] });
	await terminal.waitFor("第一条的回答");
	terminal.input.end();
	await done;
	assert.equal(faux.requests[0].messages[0].role, "user");
});
