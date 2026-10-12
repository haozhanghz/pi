// 构建系统提示词：告诉模型"你是谁、有哪些工具、要遵守哪些规则、在哪个项目里工作"。
// 对应 pi 的 packages/coding-agent/src/core/system-prompt.ts。
import type { AgentTool } from "../agent/index.ts";
import type { ContextFile } from "./context-files.ts";

export interface BuildSystemPromptOptions {
	/** 工作目录 */
	cwd: string;
	/** 可用的工具 */
	tools: AgentTool[];
	/** 项目的说明文件（AGENTS.md） */
	contextFiles?: ContextFile[];
	/** 用户自定义的提示词：替换掉默认的开头、工具介绍和规则 */
	customPrompt?: string;
	/** 追加在后面的内容 */
	appendPrompt?: string;
}

/** 内置工具在系统提示词里的一句话介绍，以及使用规则 */
const TOOL_PROMPTS: Record<string, { snippet: string; guidelines: string[] }> = {
	read: {
		snippet: "读取文件内容",
		guidelines: ["查看文件用 read，不要用 cat 或 sed"],
	},
	bash: {
		snippet: "执行 bash 命令（ls、grep、find 等）",
		guidelines: [],
	},
	edit: {
		snippet: "用精确的文字替换修改文件，一次可以修改多处",
		guidelines: [
			"用 edit 做精确的修改（edits[].oldText 必须和文件内容完全一致）",
			"同一个文件要改多处时，只调用一次 edit，把每一处都放进 edits，而不是调用多次",
			"每个 oldText 都在原文件里查找，而不是在前面的修改之后。不要让各处修改重叠，离得近的修改合并成一处",
			"oldText 在保证唯一的前提下尽量短，不要包含大段没有改动的内容",
		],
	},
	write: {
		snippet: "创建或覆盖文件",
		guidelines: ["write 只用于创建新文件或者完全重写"],
	},
	ls: {
		snippet: "列出目录内容",
		guidelines: [],
	},
};

function buildRules(tools: AgentTool[]): string {
	const rules: string[] = [];
	for (const tool of tools) rules.push(...(TOOL_PROMPTS[tool.name]?.guidelines ?? []));
	rules.push("回答要简洁", "涉及文件时，清楚地写出文件路径");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** 用 XML 标签把一段内容包起来，模型能清楚地看出每一部分从哪里开始、到哪里结束 */
function section(tag: string, content: string): string {
	return `<${tag}>\n${content}\n</${tag}>`;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const { cwd, tools, contextFiles = [], customPrompt, appendPrompt } = options;
	const parts: string[] = [];

	if (customPrompt) {
		parts.push(customPrompt);
	} else {
		parts.push(
			"你是一个专业的编程助手，运行在 mini-pi（一个 coding agent）中。你通过读取文件、执行命令、修改代码和创建新文件来帮助用户。",
		);
		const toolList = tools.map((tool) => `- ${tool.name}: ${TOOL_PROMPTS[tool.name]?.snippet ?? tool.description}`);
		parts.push(section("tools", toolList.length > 0 ? toolList.join("\n") : "（没有可用的工具）"));
		parts.push(section("rules", buildRules(tools)));
	}

	if (appendPrompt) parts.push(section("addendum", appendPrompt));

	if (contextFiles.length > 0) {
		const files = contextFiles.map(
			(file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
		);
		parts.push(section("project_context", ["项目的说明和规范：", ...files].join("\n\n")));
	}

	parts.push(section("cwd", cwd));
	return parts.join("\n\n");
}
