import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../src/agent/index.ts";
import { createFauxModel, type FauxStep } from "../src/ai/index.ts";
import { AgentSession, type AgentSessionOptions } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session.ts";
import { type InteractiveOptions, runInteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

async function waitFor(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${message}`);
		await sleep(10);
	}
}

function setup(steps: FauxStep[], sessionOptions: AgentSessionOptions = {}, options: InteractiveOptions = {}) {
	const faux = createFauxModel(steps);
	const session = new AgentSession(new Agent({ model: faux.model }), SessionManager.inMemory("/project"), sessionOptions);
	const terminal = new VirtualTerminal(70, 40);
	const done = runInteractiveMode(session, { terminal, cwd: "/project", ...options });
	const screen = () => terminal.getAllLines().join("\n");
	const exit = async () => {
		terminal.send("\x03\x03");
		await done;
	};
	return { faux, session, terminal, screen, exit };
}

test("/help 列出所有命令和快捷键", async () => {
	const { terminal, screen, exit } = setup([]);
	terminal.send("/help\r");
	await waitFor(() => screen().includes("快捷键："), "帮助");
	assert.match(screen(), /\/model\s+切换模型/);
	assert.match(screen(), /Esc\s+打断正在运行的 agent/);
	await exit();
});

test("输入 / 时显示匹配的命令，Tab 补全", async () => {
	const { terminal, screen, exit } = setup([]);
	terminal.send("/mo");
	await waitFor(() => screen().includes("/model  切换模型"), "命令提示");
	assert.doesNotMatch(screen(), /\/quit/, "只显示匹配的命令");
	terminal.send("\t");
	await waitFor(() => !screen().includes("/model  切换模型"), "补全之后提示消失");
	assert.match(terminal.getScreen().join("\n"), / \/model/);
	await exit();
});

test("/model：从列表里选一个模型", async () => {
	const { session, terminal, screen, exit } = setup([]);
	terminal.send("/model\r");
	await waitFor(() => screen().includes("筛选："), "模型列表");
	terminal.send("fake-anthropic");
	await waitFor(() => screen().includes("› fake-anthropic/fake-model"), "筛选结果");
	terminal.send("\r");
	await waitFor(() => screen().includes("已切换到 fake-anthropic/fake-model"), "切换的提示");
	assert.equal(session.agent.state.model.provider, "fake-anthropic");
	assert.doesNotMatch(terminal.getScreen().join("\n"), /筛选：/, "列表关闭，换回了输入框");
	await exit();
});

test("/model 服务商/模型：直接切换；不认识的服务商报错", async () => {
	const { session, terminal, screen, exit } = setup([]);
	terminal.send("/model fake/fake-model\r");
	await waitFor(() => screen().includes("已切换到 fake/fake-model"), "切换的提示");
	assert.equal(session.agent.state.model.provider, "fake");
	terminal.send("/model nobody/x\r");
	await waitFor(() => screen().includes("nobody"), "错误提示");
	await exit();
});

test("自动重试：出错的回复留在对话里，重试成功后显示新的回答", async () => {
	const { screen, terminal, exit } = setup([{ error: "HTTP 503：服务器太忙" }, { text: "重试之后好了" }], {
		retry: { baseDelayMs: 20 },
	});
	terminal.send("你好\r");
	await waitFor(() => screen().includes("重试之后好了"), "重试之后的回答");
	assert.match(screen(), /出错了：HTTP 503：服务器太忙[\s\S]*重试之后好了/);
	await exit();
});

test("等待重试时按 Esc：取消重试", async () => {
	const { faux, screen, terminal, exit } = setup([{ error: "HTTP 503：服务器太忙" }, { text: "不应该出现" }], {
		retry: { baseDelayMs: 10_000 },
	});
	terminal.send("你好\r");
	await waitFor(() => screen().includes("第 1/3 次重试"), "等待重试");
	terminal.send("\x1b");
	await waitFor(() => screen().includes("重试被取消了"), "取消的提示");
	assert.equal(faux.remaining, 1);
	await exit();
});

test("启动时显示设置文件的问题", async () => {
	const { screen, exit } = setup([], {}, { warnings: ["设置文件有错误，已忽略：/home/me/.mini-pi/settings.json"] });
	await waitFor(() => screen().includes("设置文件有错误"), "警告");
	await exit();
});
