// 上下文压缩：对话太长、快要超出模型的上下文窗口时，让模型把旧的部分总结成一段结构化的摘要，
// 只保留最近的消息原文。
// 对应 pi 的 packages/coding-agent/src/core/compaction/compaction.ts 和 utils.ts。
import type { StreamFunction } from "../agent/index.ts";
import { type Message, type Model, stream, type Usage, type UserMessage } from "../ai/index.ts";

export interface CompactionSettings {
	/** 是否自动压缩 */
	enabled: boolean;
	/** 给模型的回复留出的空间：上下文超过 窗口 - reserveTokens 时压缩 */
	reserveTokens: number;
	/** 压缩时保留多少 token 的最近消息（原文） */
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/**
 * 根据上下文窗口调整设置。固定的默认值不适合很小的窗口：
 * 比如本地模型只有 8K 的窗口，预留 16K 的话，"窗口 - 预留"是负数，每次都会压缩。
 * 所以两个值都不超过窗口的四分之一。
 */
export function effectiveSettings(settings: CompactionSettings, contextWindow: number): CompactionSettings {
	const quarter = Math.floor(contextWindow / 4);
	return {
		enabled: settings.enabled,
		reserveTokens: Math.min(settings.reserveTokens, quarter),
		keepRecentTokens: Math.min(settings.keepRecentTokens, quarter),
	};
}

// ---------- 估算 token ----------

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * 粗略估算一段文字有多少 token。不精确，但够用，而且不需要知道模型用的是哪种分词方法：
 *   - 英文和代码：大约 4 个字符一个 token
 *   - 汉字（以及日文、韩文）：大约一个字一个 token（宁可估多一点，早一点压缩，也不要超出窗口）
 */
export function estimateTextTokens(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 估算一条消息有多少 token */
export function estimateTokens(message: Message): number {
	if (message.role === "user") return estimateTextTokens(message.content);
	if (message.role === "toolResult") return estimateTextTokens(message.content.map((block) => block.text).join(""));
	let tokens = 0;
	for (const block of message.content) {
		if (block.type === "text") tokens += estimateTextTokens(block.text);
		else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
		else tokens += estimateTextTokens(block.name + JSON.stringify(block.arguments));
	}
	return tokens;
}

/**
 * 估算整个上下文有多少 token。
 * 最准确的数字是服务商报告的用量：最后一条正常完成的回复的 usage.totalTokens（这次请求的输入 + 输出）。
 * 它之后的消息（比如工具结果、新的问题）还没有发给模型，只能估算。
 */
export function estimateContextTokens(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			message.role === "assistant" &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			message.usage.totalTokens > 0
		) {
			let trailing = 0;
			for (const later of messages.slice(i + 1)) trailing += estimateTokens(later);
			return message.usage.totalTokens + trailing;
		}
	}
	// 还没有任何用量数据：全部估算
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}

// ---------- 找切分点 ----------

/**
 * 决定从哪里开始保留原文：从最新的消息往前累加 token，达到 keepRecentTokens 时，在那里切开。
 * 切开的位置必须是用户消息或助手消息，绝不能是工具结果——工具结果必须和它的工具调用在一起。
 *
 * @returns 第一条保留的消息的下标。返回 0 表示所有消息都保留（没有可以压缩的内容）
 */
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulated += estimateTokens(messages[i]);
		if (accumulated >= keepRecentTokens) {
			// 从这里往后，找最近的一个可以切开的位置
			for (let j = i; j < messages.length; j++) {
				if (messages[j].role !== "toolResult") return j;
			}
			// 后面全是工具结果：在它们前面的那条助手消息处切开，让工具调用和结果待在一起
			for (let j = i - 1; j >= 0; j--) {
				if (messages[j].role !== "toolResult") return j;
			}
			return 0;
		}
	}
	return 0;
}

// ---------- 生成总结 ----------

/** 工具结果在总结请求里最多保留多少个字符 */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * 把消息转成一段文字。如果把消息原样发给模型，它会以为对话还在进行，接着回答最后一个问题，而不是做总结。
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			parts.push(`[用户]：${message.content}`);
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (text) parts.push(`[助手]：${text}`);
			const calls = message.content
				.filter((block) => block.type === "toolCall")
				.map((block) => {
					const args = Object.entries(block.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
					return `${block.name}(${args.join(", ")})`;
				});
			if (calls.length > 0) parts.push(`[助手调用工具]：${calls.join("; ")}`);
		} else {
			let text = message.content.map((block) => block.text).join("");
			if (text.length > TOOL_RESULT_MAX_CHARS) {
				text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[……还有 ${text.length - TOOL_RESULT_MAX_CHARS} 个字符被省略]`;
			}
			if (text) parts.push(`[工具结果]：${text}`);
		}
	}
	return parts.join("\n\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT =
	"你是一个上下文总结助手。你的任务是阅读一段用户和 AI 助手之间的对话，然后严格按照指定的格式写出一份结构化的总结。不要继续对话，不要回答对话里的任何问题，只输出总结。";

const SUMMARY_FORMAT = `## 目标
[用户想要完成什么？如果涉及多个任务，可以列出多项]

## 约束和偏好
- [用户提出的约束、偏好和要求]
- [没有的话写"（没有）"]

## 进展
### 已完成
- [x] [已经完成的任务和修改]

### 进行中
- [ ] [正在做的工作]

### 受阻
- [阻碍进展的问题，没有就不写]

## 关键决定
- **[决定]**：[简短的理由]

## 下一步
1. [接下来应该做什么，按顺序]

## 关键上下文
- [继续工作需要的数据、例子、引用]
- [没有的话写"（没有）"]

每一部分都要简洁。准确地保留文件路径、函数名和错误信息。`;

const SUMMARIZATION_PROMPT = `上面 <conversation> 标签里是一段需要总结的对话。写一份结构化的上下文检查点，另一个 AI 会根据它继续这项工作。

严格使用下面的格式：

${SUMMARY_FORMAT}`;

const UPDATE_SUMMARIZATION_PROMPT = `上面 <conversation> 标签里是新的对话内容，<previous-summary> 标签里是之前的总结。把新的内容合并进总结里：
- 保留之前总结里的所有信息
- 加上新的进展、决定和上下文
- 更新"进展"：完成了的事情从"进行中"移到"已完成"
- 根据完成的情况更新"下一步"
- 已经不再相关的内容可以删掉

严格使用下面的格式：

${SUMMARY_FORMAT}`;

export interface SummaryOptions {
	apiKey?: string;
	signal?: AbortSignal;
	/** 之前的总结（再次压缩时，在它的基础上更新） */
	previousSummary?: string;
	/** 用户额外的要求，比如"重点记住数据库的设计" */
	customInstructions?: string;
	/** 总结最多输出多少 token */
	maxTokens?: number;
	streamFn?: StreamFunction;
}

/** 调用模型生成总结 */
export async function generateSummary(
	messages: Message[],
	model: Model,
	options: SummaryOptions = {},
): Promise<{ text: string; usage: Usage }> {
	let prompt = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
	if (options.previousSummary) prompt += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
	prompt += options.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options.customInstructions) prompt += `\n\n额外的要求：${options.customInstructions}`;

	const streamFn = options.streamFn ?? stream;
	const response = await streamFn(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		{ apiKey: options.apiKey, signal: options.signal, maxTokens: options.maxTokens },
	).result();

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`生成总结失败：${response.errorMessage ?? response.stopReason}`);
	}
	// 被截断的总结是不完整的，不能用来代替原来的对话
	if (response.stopReason === "length") throw new Error("生成总结失败：总结太长，被截断了");
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	if (!text) throw new Error("生成总结失败：模型没有返回任何内容");
	return { text, usage: response.usage };
}

// ---------- 记录读过、改过的文件 ----------

export interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从工具调用里找出读过和改过的文件，加上之前的压缩记下的文件。
 * 压缩之后模型看不到原来的工具调用了，但"动过哪些文件"是很重要的上下文。
 */
export function collectFileLists(messages: Message[], previous?: FileLists): FileLists {
	const read = new Set(previous?.readFiles);
	const modified = new Set(previous?.modifiedFiles);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || typeof block.arguments.path !== "string") continue;
			if (block.name === "read") read.add(block.arguments.path);
			else if (block.name === "write" || block.name === "edit") modified.add(block.arguments.path);
		}
	}
	return {
		readFiles: [...read].filter((path) => !modified.has(path)).sort(), // 改过的文件只出现在"改过"里
		modifiedFiles: [...modified].sort(),
	};
}

export function formatFileLists(files: FileLists): string {
	const parts: string[] = [];
	if (files.readFiles.length > 0) parts.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
	if (files.modifiedFiles.length > 0) parts.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
	return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

/** 把总结包装成一条用户消息，放在压缩后的上下文的最前面 */
export function createSummaryMessage(summary: string, timestamp: number): UserMessage {
	return {
		role: "user",
		content: `之前的对话已经被压缩成了下面这份总结：\n\n<summary>\n${summary}\n</summary>`,
		timestamp,
	};
}
