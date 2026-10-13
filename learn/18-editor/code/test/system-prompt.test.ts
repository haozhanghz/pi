import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTool } from "../src/agent/index.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createCodingTools } from "../src/tools/index.ts";

const tools = createCodingTools("/project");

test("默认的系统提示词：开头、工具列表、规则、工作目录", () => {
	const prompt = buildSystemPrompt({ cwd: "/project", tools });
	assert.ok(prompt.startsWith("你是一个专业的编程助手"));
	assert.match(prompt, /<tools>\n- read: 读取文件内容\n- bash: 执行 bash 命令/);
	assert.match(prompt, /<rules>[\s\S]*查看文件用 read，不要用 cat 或 sed[\s\S]*回答要简洁[\s\S]*<\/rules>/);
	assert.ok(prompt.endsWith("<cwd>\n/project\n</cwd>"));
});

test("规则只包含启用的工具的规则", () => {
	const prompt = buildSystemPrompt({ cwd: "/p", tools: tools.filter((tool) => tool.name === "read") });
	assert.match(prompt, /查看文件用 read/);
	assert.doesNotMatch(prompt, /oldText/);
	assert.doesNotMatch(prompt, /- bash:/);
});

test("没有内置介绍的工具：用它的 description", () => {
	const custom: AgentTool = {
		name: "weather",
		description: "查询天气",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [] };
		},
	};
	assert.match(buildSystemPrompt({ cwd: "/p", tools: [custom] }), /- weather: 查询天气/);
});

test("项目说明文件：按顺序放进 project_context，带上路径", () => {
	const prompt = buildSystemPrompt({
		cwd: "/p",
		tools: [],
		contextFiles: [
			{ path: "/home/me/.mini-pi/AGENTS.md", content: "用中文回答" },
			{ path: "/p/AGENTS.md", content: "用 npm test 跑测试" },
		],
	});
	const global = prompt.indexOf('<project_instructions path="/home/me/.mini-pi/AGENTS.md">\n用中文回答\n</project_instructions>');
	const project = prompt.indexOf('<project_instructions path="/p/AGENTS.md">\n用 npm test 跑测试\n</project_instructions>');
	assert.ok(global > 0 && project > global);
	assert.ok(prompt.indexOf("<project_context>") < global);
});

test("自定义提示词替换开头、工具和规则；追加的内容放在后面", () => {
	const prompt = buildSystemPrompt({ cwd: "/p", tools, customPrompt: "你是一只猫。", appendPrompt: "每句话以喵结尾。" });
	assert.ok(prompt.startsWith("你是一只猫。"));
	assert.doesNotMatch(prompt, /<tools>/);
	assert.match(prompt, /<addendum>\n每句话以喵结尾。\n<\/addendum>/);
	assert.match(prompt, /<cwd>\n\/p\n<\/cwd>$/, "工作目录仍然在最后");
});
