/**
 * 假模型服务器（fake LLM server）
 *
 * 用途：在没有 API key、不想花钱、或者断网的时候，也能运行课程里的每一个程序。
 * 它假装自己是一个大模型服务，支持两种最常见的协议：
 *
 *   - OpenAI Chat Completions：POST /v1/chat/completions
 *     （DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama 等都兼容这个协议）
 *   - Anthropic Messages：     POST /v1/messages
 *
 * 两种协议都支持流式（stream: true，返回 SSE）和非流式。
 *
 * 它有三种"大脑"（--mode）：
 *   rules  （默认）没有工具时复读你的话；有工具时用简单规则识别意图并发出工具调用，
 *          例如"读取 package.json"、"运行 ls"、"现在几点"、"计算 23*47"。
 *          收到工具结果后，会继续下一步或者总结。
 *   echo   永远复读最后一条用户消息。
 *   script 按 JSON 剧本依次返回预设回复（写自动化测试时用）。
 *
 * 运行：
 *   node learn/tools/fake-llm/server.ts                # 默认端口 4000
 *   node learn/tools/fake-llm/server.ts --verbose      # 打印每个请求的完整 JSON
 *   node learn/tools/fake-llm/server.ts --help
 *
 * 也可以在代码里启动（测试时常用）：
 *   const server = await startFakeLlm({ port: 0 });   // port 0 = 随机空闲端口
 *   ... server.url ...
 *   await server.close();
 *
 * 这个文件只用 Node.js 内置模块，没有任何第三方依赖。
 * 你不需要自己写它，但很值得读一读：它从"服务器这一侧"展示了流式协议长什么样。
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 剧本里的一条回复，也是"大脑"的输出。 */
export interface FakeReply {
	/** 思考过程（会以 reasoning_content / thinking 的形式发出） */
	thinking?: string;
	/** 正文 */
	text?: string;
	/** 工具调用 */
	toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> }[];
	/** 返回一个 HTTP 错误，而不是正常回复 */
	error?: { status: number; message: string; type?: string; code?: string };
	/** 模拟"输出被截断"（finish_reason = length） */
	finishReason?: "stop" | "length";
	/** 覆盖每个流式片段之间的延迟（毫秒） */
	delayMs?: number;
}

export type FakeMode = "rules" | "echo" | "script";

export interface FakeLlmOptions {
	port?: number;
	host?: string;
	mode?: FakeMode;
	/** script 模式使用的回复列表 */
	script?: FakeReply[];
	/** 流式片段之间的延迟，默认 30ms；测试时可以设为 0 */
	delayMs?: number;
	/** 是否要求请求带 API key（任意非空值即可），默认 true */
	requireApiKey?: boolean;
	/** 模拟上下文窗口（token 数）。请求超过它时返回"上下文过长"错误 */
	contextWindow?: number;
	/** 日志输出函数；默认不打印 */
	log?: (line: string) => void;
	/** 是否打印完整请求体 */
	verbose?: boolean;
	/**
	 * 把流式响应切成随机大小（1~40 字节）的碎片再发送，故意把一行、甚至一个汉字切成两半。
	 * 用来检验你的 SSE 解析器是否足够健壮。
	 */
	chop?: boolean;
}

/** 服务器记录下来的每个请求，测试可以检查"客户端到底发了什么" */
export interface RecordedRequest {
	api: "openai" | "anthropic";
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: any;
	normalized: NormalizedRequest;
}

export interface FakeLlmServer {
	/** 例如 http://127.0.0.1:4000 */
	url: string;
	port: number;
	requests: RecordedRequest[];
	/** 替换剧本并把指针归零 */
	setScript(script: FakeReply[]): void;
	close(): Promise<void>;
}

/** 把两种协议的请求统一成同一种结构，方便"大脑"处理 */
interface NormalizedMessage {
	role: "user" | "assistant" | "tool";
	text: string;
	toolCalls?: { id: string; name: string; arguments: unknown }[];
	toolName?: string;
	isError?: boolean;
}

interface NormalizedTool {
	name: string;
	/** 参数 JSON Schema 里的属性名，用来猜测该怎么填参数 */
	properties: string[];
}

interface NormalizedRequest {
	model: string;
	stream: boolean;
	includeUsage: boolean;
	system: string;
	messages: NormalizedMessage[];
	tools: NormalizedTool[];
}

// ---------------------------------------------------------------------------
// 小工具函数
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 粗略估算 token 数：中日韩文字按 1 个字 1 个 token，其他字符按 4 个字符 1 个 token */
function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) {
			cjk++;
		} else {
			other++;
		}
	}
	return cjk + Math.ceil(other / 4);
}

/** 把一段文字切成 2~4 个字符的小片段，模拟模型一点点吐字 */
function chunkText(text: string): string[] {
	const chars = Array.from(text);
	const chunks: string[] = [];
	let i = 0;
	while (i < chars.length) {
		const size = 2 + (i % 3);
		chunks.push(chars.slice(i, i + size).join(""));
		i += size;
	}
	return chunks;
}

/** 把 JSON 字符串切成固定长度的片段，模拟"工具参数"被一点点流式发送 */
function chunkJson(json: string, size = 8): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < json.length; i += size) {
		chunks.push(json.slice(i, i + size));
	}
	return chunks.length > 0 ? chunks : [""];
}

function shorten(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 个字符，已省略）` : text;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
				return "";
			})
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// 请求解析：把 OpenAI / Anthropic 的请求体统一成 NormalizedRequest
// ---------------------------------------------------------------------------

function propertiesOf(schema: any): string[] {
	if (schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object") {
		return Object.keys(schema.properties);
	}
	return [];
}

function normalizeOpenAI(body: any): NormalizedRequest {
	const messages: NormalizedMessage[] = [];
	const systemParts: string[] = [];
	const toolNamesById = new Map<string, string>();
	for (const m of body.messages ?? []) {
		if (m.role === "system" || m.role === "developer") {
			systemParts.push(textOf(m.content));
		} else if (m.role === "user") {
			messages.push({ role: "user", text: textOf(m.content) });
		} else if (m.role === "assistant") {
			const toolCalls = (m.tool_calls ?? []).map((tc: any) => {
				let args: unknown = {};
				try {
					args = JSON.parse(tc.function?.arguments || "{}");
				} catch {
					args = tc.function?.arguments;
				}
				toolNamesById.set(tc.id, tc.function?.name ?? "");
				return { id: tc.id, name: tc.function?.name ?? "", arguments: args };
			});
			messages.push({ role: "assistant", text: textOf(m.content), toolCalls });
		} else if (m.role === "tool") {
			messages.push({ role: "tool", text: textOf(m.content), toolName: toolNamesById.get(m.tool_call_id) ?? "?" });
		}
	}
	const tools: NormalizedTool[] = (body.tools ?? []).map((t: any) => ({
		name: t.function?.name ?? t.name ?? "",
		properties: propertiesOf(t.function?.parameters ?? t.parameters),
	}));
	return {
		model: String(body.model ?? ""),
		stream: body.stream === true,
		includeUsage: body.stream_options?.include_usage === true,
		system: systemParts.join("\n"),
		messages,
		tools,
	};
}

function normalizeAnthropic(body: any): NormalizedRequest {
	const messages: NormalizedMessage[] = [];
	const toolNamesById = new Map<string, string>();
	for (const m of body.messages ?? []) {
		if (typeof m.content === "string") {
			messages.push({ role: m.role === "assistant" ? "assistant" : "user", text: m.content });
			continue;
		}
		const blocks: any[] = Array.isArray(m.content) ? m.content : [];
		if (m.role === "assistant") {
			const toolCalls = blocks
				.filter((b) => b.type === "tool_use")
				.map((b) => {
					toolNamesById.set(b.id, b.name);
					return { id: b.id, name: b.name, arguments: b.input };
				});
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
			messages.push({ role: "assistant", text, toolCalls });
		} else {
			// user 消息里可能混着 tool_result 和 text
			for (const b of blocks) {
				if (b.type === "tool_result") {
					messages.push({
						role: "tool",
						text: textOf(b.content),
						toolName: toolNamesById.get(b.tool_use_id) ?? "?",
						isError: b.is_error === true,
					});
				}
			}
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
			if (text.length > 0) messages.push({ role: "user", text });
		}
	}
	const tools: NormalizedTool[] = (body.tools ?? []).map((t: any) => ({
		name: t.name ?? "",
		properties: propertiesOf(t.input_schema),
	}));
	return {
		model: String(body.model ?? ""),
		stream: body.stream === true,
		includeUsage: true,
		system: textOf(body.system),
		messages,
		tools,
	};
}

// ---------------------------------------------------------------------------
// "大脑"：根据请求决定回复什么
// ---------------------------------------------------------------------------

function echoBrain(req: NormalizedRequest): FakeReply {
	const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
	const said = lastUser ? lastUser.text : "";
	const info = `（本次请求共包含 ${req.messages.length} 条消息${req.system ? "，以及一段系统提示词" : ""}）`;
	if (!said) return { text: `你好！我是假模型。${info}` };
	return { text: `你说的是：「${said}」。我是假模型，只会复读。${info}` };
}

interface Intent {
	/** 意图名，方便日志 */
	kind: string;
	/** 候选工具名，按顺序找第一个存在的 */
	tools: string[];
	/** 根据工具的参数属性名构造参数 */
	args: (props: string[]) => Record<string, unknown>;
	/** 调用工具前说的话 */
	say: string;
}

/** 在参数属性名里找一个合适的名字，例如 path / file_path / filename */
function pickProp(props: string[], candidates: string[], fallback: string): string {
	for (const c of candidates) if (props.includes(c)) return c;
	return props[0] ?? fallback;
}

/** 从一句话里识别一个意图 */
function parseIntent(segment: string): Intent | undefined {
	// 去掉开头的客气话和结尾的标点，然后要求动词出现在开头，避免"运行 ls"被误认为"列出"
	const s = segment
		.trim()
		.replace(/^(?:请你?|帮我|麻烦你?|please)\s*/i, "")
		.replace(/[。！？]+$/, "");
	let m: RegExpMatchArray | null;

	m = s.match(/^(?:计算|算一下|算算|calculate|calc)\s*[:：]?\s*(.+)/i);
	if (m) {
		const expression = m[1].trim();
		return {
			kind: "calc",
			tools: ["calculate", "calculator", "calc"],
			args: (props) => ({ [pickProp(props, ["expression", "expr", "input"], "expression")]: expression }),
			say: `我来计算 ${expression}。`,
		};
	}
	m = s.match(/^(?:把|将)\s*(\S+?)\s*(?:里|中|文件里)?的?\s*[“"「](.+?)[”"」]\s*(?:改成|替换为|换成|改为)\s*[“"「](.+?)[”"」]/);
	if (m) {
		const [, path, oldText, newText] = m;
		return {
			kind: "edit",
			tools: ["edit", "edit_file"],
			args: (props) =>
				props.includes("edits")
					? { [pickProp(props, ["path", "file_path"], "path")]: path, edits: [{ oldText, newText }] }
					: { [pickProp(props, ["path", "file_path"], "path")]: path, oldText, newText },
			say: `我来修改 ${path}。`,
		};
	}
	m = s.match(/^(?:写入|创建|新建|write)\s*[:：]?\s*(\S+)\s+(?:内容\s*[:：]?\s*)?([\s\S]+)/i);
	if (m) {
		const [, path, content] = m;
		return {
			kind: "write",
			tools: ["write", "write_file"],
			args: (props) => ({
				[pickProp(props, ["path", "file_path", "filename"], "path")]: path,
				[pickProp(
					props.filter((p) => p !== "path" && p !== "file_path"),
					["content", "text", "data"],
					"content",
				)]: content.trim(),
			}),
			say: `我来写入 ${path}。`,
		};
	}
	m = s.match(/^(?:读取|读一下|看看|查看|打开|read)\s*[:：]?\s*(\S+)/i);
	if (m) {
		const path = m[1];
		return {
			kind: "read",
			tools: ["read", "read_file"],
			args: (props) => ({ [pickProp(props, ["path", "file_path", "filename"], "path")]: path }),
			say: `我来读取 ${path}。`,
		};
	}
	m = s.match(/^(?:列出|列一下|ls|list)(?:\s+|$|[:：]\s*)(\S*)/i);
	if (m) {
		const path = m[1] || ".";
		return {
			kind: "ls",
			tools: ["ls", "list_files", "bash"],
			args: (props) =>
				props.includes("command")
					? { command: `ls ${path}` }
					: { [pickProp(props, ["path", "dir", "directory"], "path")]: path },
			say: `我来看看 ${path} 里有什么。`,
		};
	}
	m = s.match(/^(?:运行|执行|run)\s*[:：]?\s*(.+)/i);
	if (m) {
		const command = m[1].trim();
		return {
			kind: "bash",
			tools: ["bash", "shell", "run_command"],
			args: (props) => ({ [pickProp(props, ["command", "cmd"], "command")]: command }),
			say: `我来运行 \`${command}\`。`,
		};
	}
	// 问时间放在最后判断：避免"运行 date 看看时间"被误认为问时间
	if (/几点|时间|日期|what time|current time/i.test(s)) {
		return {
			kind: "time",
			tools: ["get_current_time", "get_time", "current_time", "time"],
			args: () => ({}),
			say: "我来查一下当前时间。",
		};
	}
	return undefined;
}

/**
 * 上下文压缩（里程碑 15）时，agent 会请模型总结对话。假模型从对话里摘出用户的请求和工具调用，拼出一份结构化的总结。
 * 系统提示词里有"上下文总结助手"（或者 pi 的英文版 "context summarization assistant"）就认为是总结请求。
 */
function summaryBrain(req: NormalizedRequest): FakeReply | undefined {
	if (!/上下文总结助手|context summarization assistant/i.test(req.system)) return undefined;
	const prompt = [...req.messages].reverse().find((m) => m.role === "user")?.text ?? "";
	const conversation = prompt.match(/<conversation>([\s\S]*?)<\/conversation>/)?.[1] ?? "";
	const previous = prompt.match(/<previous-summary>([\s\S]*?)<\/previous-summary>/)?.[1] ?? "";
	const requests = [...conversation.matchAll(/^\[(?:用户|User)\][：:]\s*(.+)$/gm)].map((m) => m[1].trim());
	const calls = [...conversation.matchAll(/^\[(?:助手调用工具|Assistant tool calls)\][：:]\s*(.+)$/gm)].map((m) => m[1].trim());
	// 之前总结里的目标也保留下来
	const previousGoals = (previous.match(/## 目标\n([\s\S]*?)\n\n/)?.[1] ?? "")
		.split("\n")
		.map((line) => line.replace(/^-\s*/, "").trim())
		.filter((line) => line && !line.startsWith("（"));
	const goals = [...new Set([...previousGoals, ...requests])];
	const list = (items: string[], prefix: string) => (items.length > 0 ? items.map((item) => `${prefix}${item}`).join("\n") : "- （没有）");
	const text = `## 目标
${list(goals.slice(-10), "- ")}

## 约束和偏好
- （没有）

## 进展
### 已完成
${list(calls.slice(-10), "- [x] ")}

### 进行中
- [ ] ${requests.at(-1) ?? goals.at(-1) ?? "（没有）"}

## 关键决定
- （没有）

## 下一步
1. 继续完成用户最后的请求

## 关键上下文
- 这份总结是假模型拼出来的，只用来演示压缩的流程`;
	return { text };
}

function rulesBrain(req: NormalizedRequest): FakeReply {
	const summary = summaryBrain(req);
	if (summary) return summary;

	// 找到最后一条"用户说的话"
	let lastUserIndex = -1;
	for (let i = req.messages.length - 1; i >= 0; i--) {
		if (req.messages[i].role === "user") {
			lastUserIndex = i;
			break;
		}
	}
	if (lastUserIndex === -1) return echoBrain(req);
	let userText = req.messages[lastUserIndex].text;
	// 上下文压缩之后（里程碑 15），最后一条"用户消息"可能是那份总结：从总结的"进行中"里找出用户正在做的事
	const inProgress = userText.includes("<summary>") ? userText.match(/### 进行中\n- \[ \] (.+)/)?.[1] : undefined;
	if (inProgress) userText = inProgress;

	// "A 同时 B" = 并行；"A 然后 B" = 一步一步来
	const parallel = /同时/.test(userText);
	const segments = userText.split(parallel ? /\s*同时\s*/ : /(?:[，,；;]\s*)?(?:然后|接着|随后|and then)\s*/i);
	const planned: { intent: Intent; tool: NormalizedTool }[] = [];
	const missing: string[] = [];
	for (const segment of segments) {
		const intent = parseIntent(segment);
		if (!intent) continue;
		const tool = intent.tools.map((name) => req.tools.find((t) => t.name === name)).find((t) => t !== undefined);
		if (tool) planned.push({ intent, tool });
		else missing.push(intent.tools[0]);
	}

	// 用户说完之后，已经收到了哪些工具结果？
	const after = req.messages.slice(lastUserIndex + 1);
	const results = after.filter((m) => m.role === "tool");
	const callsSoFar = after.filter((m) => m.role === "assistant").reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);

	if (planned.length === 0) {
		if (missing.length > 0) {
			return {
				text: `我大概明白你想做什么，但这次请求里没有提供需要的工具（${missing.join("、")}）。${
					req.tools.length > 0 ? `可用的工具有：${req.tools.map((t) => t.name).join("、")}。` : "这次请求没有带任何工具。"
				}`,
			};
		}
		return echoBrain(req);
	}

	// 还有没执行的步骤：发出下一个（或者全部，如果是并行）工具调用
	if (callsSoFar < planned.length) {
		const next = parallel ? planned : [planned[callsSoFar]];
		return {
			text: next.map((p) => p.intent.say).join(""),
			toolCalls: next.map((p) => ({ name: p.tool.name, arguments: p.intent.args(p.tool.properties) })),
		};
	}

	// 所有步骤都做完了：总结
	const lines = results.map((r, i) => {
		const status = r.isError ? "（出错）" : "";
		return `${i + 1}. ${r.toolName}${status}：\n${shorten(r.text, 600)}`;
	});
	return { text: `完成！一共执行了 ${results.length} 个工具调用，结果如下：\n\n${lines.join("\n\n")}` };
}

// ---------------------------------------------------------------------------
// 回复的编码：把 FakeReply 编码成 OpenAI / Anthropic 的响应格式
// ---------------------------------------------------------------------------

interface ReplyMeta {
	model: string;
	promptTokens: number;
	completionTokens: number;
	delayMs: number;
	includeUsage: boolean;
	chop: boolean;
}

/**
 * 往响应里写一段 SSE 文本。chop 模式下把它切成随机大小的字节碎片，
 * 每片之间稍等一下，确保客户端是分多次收到的。
 */
async function writeSse(res: ServerResponse, text: string, meta: ReplyMeta): Promise<void> {
	if (!meta.chop) {
		res.write(text);
		return;
	}
	const bytes = Buffer.from(text, "utf-8");
	let offset = 0;
	while (offset < bytes.length) {
		const size = 1 + Math.floor(Math.random() * 40);
		res.write(bytes.subarray(offset, offset + size));
		offset += size;
		await sleep(1);
	}
}

function withIds(reply: FakeReply, prefix: string) {
	return (reply.toolCalls ?? []).map((tc) => ({
		id: tc.id ?? randomId(prefix),
		name: tc.name,
		json: JSON.stringify(tc.arguments ?? {}),
		arguments: tc.arguments ?? {},
	}));
}

function openAIFinishReason(reply: FakeReply): string {
	if (reply.finishReason === "length") return "length";
	return (reply.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop";
}

function openAIUsage(meta: ReplyMeta) {
	return {
		prompt_tokens: meta.promptTokens,
		completion_tokens: meta.completionTokens,
		total_tokens: meta.promptTokens + meta.completionTokens,
	};
}

function sendOpenAIJson(res: ServerResponse, reply: FakeReply, meta: ReplyMeta): void {
	const toolCalls = withIds(reply, "call");
	const message: Record<string, unknown> = {
		role: "assistant",
		content: reply.text ?? (toolCalls.length > 0 ? null : ""),
	};
	if (reply.thinking) message.reasoning_content = reply.thinking;
	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls.map((tc) => ({
			id: tc.id,
			type: "function",
			function: { name: tc.name, arguments: tc.json },
		}));
	}
	const body = {
		id: randomId("chatcmpl"),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: meta.model,
		choices: [{ index: 0, message, finish_reason: openAIFinishReason(reply) }],
		usage: openAIUsage(meta),
	};
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function sendOpenAIStream(
	res: ServerResponse,
	reply: FakeReply,
	meta: ReplyMeta,
	isClosed: () => boolean,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	const id = randomId("chatcmpl");
	const created = Math.floor(Date.now() / 1000);
	const send = async (choices: unknown[], extra: Record<string, unknown> = {}) => {
		if (isClosed()) return;
		const chunk = { id, object: "chat.completion.chunk", created, model: meta.model, choices, ...extra };
		await writeSse(res, `data: ${JSON.stringify(chunk)}\n\n`, meta);
		if (meta.delayMs > 0) await sleep(meta.delayMs);
	};
	const delta = (d: Record<string, unknown>, finish: string | null = null) => [
		{ index: 0, delta: d, finish_reason: finish },
	];

	await send(delta({ role: "assistant", content: "" }));
	if (reply.thinking) {
		for (const piece of chunkText(reply.thinking)) await send(delta({ reasoning_content: piece }));
	}
	if (reply.text) {
		for (const piece of chunkText(reply.text)) await send(delta({ content: piece }));
	}
	const toolCalls = withIds(reply, "call");
	for (let index = 0; index < toolCalls.length; index++) {
		const tc = toolCalls[index];
		// 第一个片段带上 id 和函数名，参数为空字符串
		await send(
			delta({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }] }),
		);
		// 后续片段只带参数的一小段
		for (const piece of chunkJson(tc.json)) {
			await send(delta({ tool_calls: [{ index, function: { arguments: piece } }] }));
		}
	}
	await send(delta({}, openAIFinishReason(reply)));
	if (meta.includeUsage) {
		await send([], { usage: openAIUsage(meta) });
	}
	if (!isClosed()) {
		await writeSse(res, "data: [DONE]\n\n", meta);
		res.end();
	}
}

function anthropicStopReason(reply: FakeReply): string {
	if (reply.finishReason === "length") return "max_tokens";
	return (reply.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn";
}

function sendAnthropicJson(res: ServerResponse, reply: FakeReply, meta: ReplyMeta): void {
	const content: unknown[] = [];
	if (reply.thinking) content.push({ type: "thinking", thinking: reply.thinking, signature: "fake-signature" });
	if (reply.text) content.push({ type: "text", text: reply.text });
	for (const tc of withIds(reply, "toolu")) {
		content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
	}
	const body = {
		id: randomId("msg"),
		type: "message",
		role: "assistant",
		model: meta.model,
		content,
		stop_reason: anthropicStopReason(reply),
		stop_sequence: null,
		usage: { input_tokens: meta.promptTokens, output_tokens: meta.completionTokens },
	};
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function sendAnthropicStream(
	res: ServerResponse,
	reply: FakeReply,
	meta: ReplyMeta,
	isClosed: () => boolean,
): Promise<void> {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	const send = async (event: string, data: Record<string, unknown>) => {
		if (isClosed()) return;
		await writeSse(res, `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`, meta);
		if (meta.delayMs > 0) await sleep(meta.delayMs);
	};

	await send("message_start", {
		message: {
			id: randomId("msg"),
			type: "message",
			role: "assistant",
			model: meta.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: meta.promptTokens, output_tokens: 1 },
		},
	});
	// 真实服务偶尔会发 ping 事件，客户端应该忽略不认识的事件
	await send("ping", {});

	let index = 0;
	if (reply.thinking) {
		await send("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
		for (const piece of chunkText(reply.thinking)) {
			await send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: piece } });
		}
		await send("content_block_delta", { index, delta: { type: "signature_delta", signature: "fake-signature" } });
		await send("content_block_stop", { index });
		index++;
	}
	if (reply.text) {
		await send("content_block_start", { index, content_block: { type: "text", text: "" } });
		for (const piece of chunkText(reply.text)) {
			await send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
		}
		await send("content_block_stop", { index });
		index++;
	}
	for (const tc of withIds(reply, "toolu")) {
		await send("content_block_start", {
			index,
			content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
		});
		for (const piece of chunkJson(tc.json)) {
			await send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
		}
		await send("content_block_stop", { index });
		index++;
	}
	await send("message_delta", {
		delta: { stop_reason: anthropicStopReason(reply), stop_sequence: null },
		usage: { output_tokens: meta.completionTokens },
	});
	await send("message_stop", {});
	if (!isClosed()) res.end();
}

// ---------------------------------------------------------------------------
// 错误响应
// ---------------------------------------------------------------------------

function sendError(
	res: ServerResponse,
	api: "openai" | "anthropic",
	status: number,
	message: string,
	type = "invalid_request_error",
	code?: string,
): void {
	const body =
		api === "anthropic"
			? { type: "error", error: { type, message } }
			: { error: { message, type, ...(code ? { code } : {}) } };
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function describeReply(reply: FakeReply): string {
	if (reply.error) return `错误 ${reply.error.status}`;
	const parts: string[] = [];
	if (reply.thinking) parts.push("思考");
	if (reply.text) parts.push(`文字(${reply.text.length}字)`);
	for (const tc of reply.toolCalls ?? []) parts.push(`工具调用 ${tc.name}(${JSON.stringify(tc.arguments)})`);
	return parts.join(" + ") || "空回复";
}

export async function startFakeLlm(options: FakeLlmOptions = {}): Promise<FakeLlmServer> {
	const mode: FakeMode = options.mode ?? (options.script ? "script" : "rules");
	const delayMs = options.delayMs ?? 30;
	const requireApiKey = options.requireApiKey ?? true;
	const log = options.log ?? (() => {});
	const requests: RecordedRequest[] = [];
	let script = options.script ?? [];
	let scriptIndex = 0;

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		const time = new Date().toTimeString().slice(0, 8);

		// 列出模型：有些客户端会先调这个接口
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] }));
			return;
		}

		const isOpenAI = req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions");
		const isAnthropic = req.method === "POST" && (path === "/v1/messages" || path === "/messages");
		if (!isOpenAI && !isAnthropic) {
			sendError(res, "openai", 404, `假模型服务器不认识这个地址：${req.method} ${path}`, "not_found");
			log(`[${time}] ${req.method} ${path} → 404（地址不对？OpenAI 用 /v1/chat/completions，Anthropic 用 /v1/messages）`);
			return;
		}
		const api = isOpenAI ? "openai" : "anthropic";

		// 鉴权：真实服务没有 key 会返回 401，这里模仿它
		const authHeader = req.headers.authorization;
		const apiKey = isOpenAI
			? typeof authHeader === "string" && authHeader.startsWith("Bearer ")
				? authHeader.slice(7).trim()
				: ""
			: String(req.headers["x-api-key"] ?? "");
		if (requireApiKey && !apiKey) {
			const hint = isOpenAI
				? "缺少 API key：请求头里需要 Authorization: Bearer <key>（假服务器接受任意非空 key，例如 fake）"
				: "缺少 API key：请求头里需要 x-api-key: <key>（假服务器接受任意非空 key，例如 fake）";
			sendError(res, api, 401, hint, "authentication_error");
			log(`[${time}] POST ${path} → 401 没有 API key`);
			return;
		}

		let body: any;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			sendError(res, api, 400, "请求体不是合法的 JSON");
			log(`[${time}] POST ${path} → 400 请求体不是 JSON`);
			return;
		}
		if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
			sendError(res, api, 400, "请求体里缺少 messages 数组");
			log(`[${time}] POST ${path} → 400 缺少 messages`);
			return;
		}
		if (!body.model) {
			sendError(res, api, 400, "请求体里缺少 model 字段");
			log(`[${time}] POST ${path} → 400 缺少 model`);
			return;
		}
		if (isAnthropic && typeof body.max_tokens !== "number") {
			sendError(res, api, 400, "Anthropic 协议要求请求体里有 max_tokens（数字）");
			log(`[${time}] POST ${path} → 400 缺少 max_tokens`);
			return;
		}

		const normalized = isOpenAI ? normalizeOpenAI(body) : normalizeAnthropic(body);
		requests.push({ api, path, headers: req.headers, body, normalized });
		if (options.verbose) {
			log(`[${time}] 收到请求体：\n${JSON.stringify(body, null, 2)}`);
		}

		// 估算输入 token 数，并模拟"上下文过长"。和真实的服务商一样，工具定义也算在输入里
		const promptText =
			normalized.system +
			normalized.messages.map((m) => m.text + JSON.stringify(m.toolCalls ?? [])).join("") +
			JSON.stringify(body.tools ?? []);
		const promptTokens = estimateTokens(promptText);
		if (options.contextWindow !== undefined && promptTokens > options.contextWindow) {
			const message = `This model's maximum context length is ${options.contextWindow} tokens. However, your messages resulted in ${promptTokens} tokens.`;
			sendError(res, api, 400, message, "invalid_request_error", "context_length_exceeded");
			log(`[${time}] POST ${path} → 400 上下文过长（${promptTokens} > ${options.contextWindow}）`);
			return;
		}

		// 让大脑决定回复
		let reply: FakeReply;
		if (mode === "script") {
			if (scriptIndex >= script.length) {
				sendError(res, api, 500, `fake-llm: 剧本已经用完（共 ${script.length} 条回复）`, "server_error");
				log(`[${time}] POST ${path} → 500 剧本已用完`);
				return;
			}
			reply = script[scriptIndex++];
		} else if (mode === "echo") {
			reply = echoBrain(normalized);
		} else {
			reply = rulesBrain(normalized);
		}

		log(
			`[${time}] ${api === "openai" ? "OpenAI" : "Anthropic"} 请求 model=${normalized.model} stream=${normalized.stream} ` +
				`消息=${normalized.messages.length} 工具=${normalized.tools.length} → ${describeReply(reply)}`,
		);

		if (reply.error) {
			sendError(res, api, reply.error.status, reply.error.message, reply.error.type ?? "server_error", reply.error.code);
			return;
		}

		const completionText = (reply.thinking ?? "") + (reply.text ?? "") + JSON.stringify(reply.toolCalls ?? []);
		const meta: ReplyMeta = {
			model: normalized.model,
			promptTokens,
			completionTokens: estimateTokens(completionText),
			delayMs: reply.delayMs ?? delayMs,
			includeUsage: normalized.includeUsage,
			chop: options.chop === true,
		};

		// 客户端中途断开（比如用户按了 Ctrl+C）时，停止继续发送
		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		const isClosed = () => closed;

		try {
			if (api === "openai") {
				if (normalized.stream) await sendOpenAIStream(res, reply, meta, isClosed);
				else sendOpenAIJson(res, reply, meta);
			} else {
				if (normalized.stream) await sendAnthropicStream(res, reply, meta, isClosed);
				else sendAnthropicJson(res, reply, meta);
			}
		} catch (error) {
			log(`[${time}] 发送回复时出错：${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) sendError(res, api, 500, "fake-llm internal error", "server_error");
			else res.end();
		}
		if (closed) log(`[${time}] 客户端提前断开了连接`);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 4000, options.host ?? "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	const url = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

	return {
		url,
		port: address.port,
		requests,
		setScript(next: FakeReply[]) {
			script = next;
			scriptIndex = 0;
		},
		close() {
			return new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 命令行入口
// ---------------------------------------------------------------------------

const HELP = `假模型服务器（课程用）

用法：
  node learn/tools/fake-llm/server.ts [选项]

选项：
  --port <端口>            监听端口，默认 4000
  --mode <rules|echo|script>  大脑类型，默认 rules
  --script <文件>          剧本文件（JSON 数组），会自动切换到 script 模式
  --delay <毫秒>           流式片段之间的延迟，默认 30
  --context-window <数字>  模拟上下文窗口，超过就返回"上下文过长"错误
  --no-auth                不检查 API key
  --verbose                打印每个请求的完整 JSON（强烈推荐学习时打开）
  --chop                   把流式响应切成随机大小的碎片发送（检验 SSE 解析器，里程碑 05 用）
  -h, --help               显示帮助

rules 模式能听懂的话（需要请求里带了对应的工具）：
  现在几点            → get_current_time
  计算 23*47          → calculate
  读取 package.json   → read
  列出 src            → ls（或 bash）
  运行 node --version → bash
  写入 a.txt 内容 你好 → write
  把 a.txt 里的"你好"改成"再见" → edit
  用"然后"连接多个步骤会一步一步执行，用"同时"连接会在一次回复里并行调用。`;

// 只有直接运行这个文件时才启动服务器；被 import 时只导出 startFakeLlm
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "4000" },
			mode: { type: "string" },
			script: { type: "string" },
			delay: { type: "string", default: "30" },
			"context-window": { type: "string" },
			"no-auth": { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			chop: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	if (values.help) {
		console.log(HELP);
		process.exit(0);
	}

	let script: FakeReply[] | undefined;
	if (values.script) {
		const parsed = JSON.parse(readFileSync(values.script, "utf-8"));
		script = Array.isArray(parsed) ? parsed : parsed.replies;
	}
	const mode = (values.mode as FakeMode | undefined) ?? (script ? "script" : "rules");
	if (!["rules", "echo", "script"].includes(mode)) {
		console.error(`未知的 --mode：${mode}（可选 rules / echo / script）`);
		process.exit(1);
	}

	const server = await startFakeLlm({
		port: Number(values.port),
		mode,
		script,
		delayMs: Number(values.delay),
		requireApiKey: !values["no-auth"],
		contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
		verbose: values.verbose,
		chop: values.chop,
		log: (line) => console.log(line),
	});

	const host = server.url.replace("127.0.0.1", "localhost");
	console.log(`假模型服务器已启动：${host}

  OpenAI 兼容地址（LLM_BASE_URL）：   ${host}/v1
  Anthropic 兼容地址：                ${host}
  API key：任意非空字符串，例如 fake
  模型名：任意，例如 fake-model
  大脑模式：${mode}${script ? `（剧本共 ${script.length} 条回复）` : ""}

每收到一个请求，这里会打印一行日志。按 Ctrl+C 退出。`);

	process.on("SIGINT", async () => {
		await server.close();
		process.exit(0);
	});
}
