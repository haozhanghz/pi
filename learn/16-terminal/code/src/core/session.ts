// 会话：把对话保存到文件里，关掉程序之后还能接着聊。
// 格式是 JSONL（每行一个 JSON 对象），只往文件末尾追加，从不修改已经写下的内容。
// 对应 pi 的 packages/coding-agent/src/core/session-manager.ts。
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message } from "../ai/index.ts";
import { createSummaryMessage, type FileLists } from "./compaction.ts";

export const SESSION_VERSION = 1;

/** 文件的第一行：会话的基本信息 */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	/** 在哪个目录里开始的这个会话 */
	cwd: string;
}

interface EntryBase {
	/** 8 位十六进制的短 id */
	id: string;
	/** 上一条记录的 id。第一条记录是 null */
	parentId: string | null;
	timestamp: string;
}

/** 一条消息 */
export interface MessageEntry extends EntryBase {
	type: "message";
	message: Message;
}

/** 换了模型 */
export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/** 上下文压缩：summary 代替了 firstKeptEntryId 之前的所有消息 */
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	/** 从这条记录开始的消息保留原文 */
	firstKeptEntryId: string;
	/** 压缩前上下文大约有多少 token */
	tokensBefore: number;
	/** 读过、改过的文件，下次压缩时接着用 */
	details?: FileLists;
}

export type SessionEntry = MessageEntry | ModelChangeEntry | CompactionEntry;
type FileEntry = SessionHeader | SessionEntry;

/** 从会话里恢复出来的上下文 */
export interface SessionContext {
	messages: Message[];
	/** 最后一次选择的模型 */
	model?: { provider: string; modelId: string };
}

/** 会话列表里的一项（--resume 时显示） */
export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	/** 第一条用户消息，当作标题 */
	firstMessage: string;
	messageCount: number;
	modified: Date;
}

/**
 * 每个工作目录一个文件夹：~/.mini-pi/sessions/--home-you-todo-app--/
 * 路径里的 / 换成 -，前后加上 --，变成一个合法的文件夹名
 */
export function getSessionDir(agentDir: string, cwd: string): string {
	const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/** 解析会话文件的内容。解析不了的行（比如程序崩溃时只写了一半的最后一行）直接跳过 */
export function parseSessionFile(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// 跳过坏掉的行
		}
	}
	return entries;
}

export class SessionManager {
	private header: SessionHeader;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	/** 当前位置：新的记录会接在它后面 */
	private leafId: string | null = null;
	/** 会话文件的路径。undefined 表示不保存（只在内存里） */
	private file: string | undefined;
	/** 文件是否已经创建 */
	private flushed = false;
	private readonly sessionDir: string;
	/** 是否保存到文件 */
	private readonly persistEnabled: boolean;

	private constructor(cwd: string, sessionDir: string, file: string | undefined, persist: boolean) {
		this.sessionDir = sessionDir;
		this.persistEnabled = persist;
		this.header = { type: "session", version: SESSION_VERSION, id: "", timestamp: "", cwd: resolve(cwd) };
		if (file) this.load(file);
		else this.startNew();
	}

	/** 新建一个会话（文件要等到有了第一条消息才会创建） */
	static create(cwd: string, sessionDir: string): SessionManager {
		return new SessionManager(cwd, sessionDir, undefined, true);
	}

	/** 打开一个会话文件 */
	static open(file: string): SessionManager {
		const path = resolve(file);
		if (!existsSync(path)) throw new Error(`会话文件不存在：${path}`);
		const header = parseSessionFile(readFileSync(path, "utf-8")).find((entry) => entry.type === "session");
		return new SessionManager(header?.cwd ?? process.cwd(), resolve(path, ".."), path, true);
	}

	/** 继续这个目录里最近的一个会话；没有的话新建一个 */
	static continueRecent(cwd: string, sessionDir: string): SessionManager {
		const recent = SessionManager.list(sessionDir)[0];
		return recent ? SessionManager.open(recent.path) : SessionManager.create(cwd, sessionDir);
	}

	/** 不保存到文件的会话（--no-session） */
	static inMemory(cwd: string): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	/** 列出一个文件夹里的所有会话，最近修改的排在前面 */
	static list(sessionDir: string): SessionInfo[] {
		if (!existsSync(sessionDir)) return [];
		const sessions: SessionInfo[] = [];
		for (const name of readdirSync(sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(sessionDir, name);
			const entries = parseSessionFile(readFileSync(path, "utf-8"));
			const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
			if (!header) continue;
			const messages = entries.filter((entry): entry is MessageEntry => entry.type === "message");
			const first = messages.find((entry) => entry.message.role === "user")?.message;
			sessions.push({
				path,
				id: header.id,
				cwd: header.cwd,
				firstMessage: first?.role === "user" ? first.content : "（没有消息）",
				messageCount: messages.length,
				modified: statSync(path).mtime,
			});
		}
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	/** 根据 id（可以只写开头几个字符）找会话文件 */
	static findById(sessionDir: string, id: string): string | undefined {
		return SessionManager.list(sessionDir).find((session) => session.id.startsWith(id))?.path;
	}

	get sessionId(): string {
		return this.header.id;
	}

	get sessionFile(): string | undefined {
		return this.file;
	}

	get cwd(): string {
		return this.header.cwd;
	}

	/** 开始一个新的会话（/new 命令会用到） */
	newSession(): void {
		this.startNew();
	}

	appendMessage(message: Message): string {
		return this.append({ type: "message", id: this.newId(), parentId: this.leafId, timestamp: now(), message });
	}

	appendModelChange(provider: string, modelId: string): string {
		return this.append({ type: "model_change", id: this.newId(), parentId: this.leafId, timestamp: now(), provider, modelId });
	}

	appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: FileLists): string {
		return this.append({
			type: "compaction",
			id: this.newId(),
			parentId: this.leafId,
			timestamp: now(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
		});
	}

	/** 从第一条记录到当前位置的路径 */
	getBranch(): SessionEntry[] {
		const path: SessionEntry[] = [];
		let id = this.leafId;
		while (id !== null) {
			const entry = this.byId.get(id);
			if (!entry) break;
			path.unshift(entry);
			id = entry.parentId;
		}
		return path;
	}

	/**
	 * 恢复上下文：当前路径上的消息，以及最后选择的模型。
	 * 路径上有压缩记录时，用最新的那条：总结 + 从 firstKeptEntryId 开始保留的消息 + 压缩之后的消息。
	 */
	buildContext(): SessionContext {
		const branch = this.getBranch();
		const context: SessionContext = { messages: [] };
		for (const entry of branch) {
			if (entry.type === "model_change") context.model = { provider: entry.provider, modelId: entry.modelId };
		}

		const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
		const compaction = branch[compactionIndex];
		let start = 0;
		if (compaction?.type === "compaction") {
			context.messages.push(createSummaryMessage(compaction.summary, Date.parse(compaction.timestamp)));
			const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
			start = keptIndex !== -1 ? keptIndex : compactionIndex + 1;
		}
		for (const entry of branch.slice(start)) {
			if (entry.type === "message") context.messages.push(entry.message);
		}
		return context;
	}

	/** 当前路径上最新的压缩记录 */
	getLatestCompaction(): CompactionEntry | undefined {
		return this.getBranch().findLast((entry): entry is CompactionEntry => entry.type === "compaction");
	}

	/** 把当前位置移回到某条记录。之后的新记录会从那里长出一个新的分支，原来的记录不会被删除 */
	branch(entryId: string): void {
		if (!this.byId.has(entryId)) throw new Error(`没有这条记录：${entryId}`);
		this.leafId = entryId;
	}

	getEntries(): SessionEntry[] {
		return [...this.entries];
	}

	private startNew(): void {
		const timestamp = now();
		this.header = { type: "session", version: SESSION_VERSION, id: randomUUID(), timestamp, cwd: this.header.cwd };
		this.entries = [];
		this.byId.clear();
		this.leafId = null;
		this.flushed = false;
		// 文件名以时间开头，按文件名排序就是按时间排序
		this.file = this.persistEnabled
			? join(this.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${this.header.id}.jsonl`)
			: undefined;
	}

	private load(file: string): void {
		const entries = parseSessionFile(readFileSync(file, "utf-8"));
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		if (!header) throw new Error(`不是一个会话文件：${file}`);
		this.header = header;
		this.entries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.leafId = this.entries.at(-1)?.id ?? null; // 最后一条记录就是当前位置
		this.file = file;
		this.flushed = true;
	}

	private append(entry: SessionEntry): string {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this.persist(entry);
		return entry.id;
	}

	private persist(entry: SessionEntry): void {
		if (!this.file) return;
		if (!this.flushed) {
			// 只有设置、还没有对话的会话不创建文件：打开程序又马上关掉，不会留下一个空的会话
			const hasConversation = this.entries.some((item) => item.type === "message");
			if (!hasConversation) return;
			mkdirSync(this.sessionDir, { recursive: true });
			const fd = openSync(this.file, "wx"); // wx：文件已存在时报错，绝不覆盖别的会话
			try {
				for (const item of [this.header, ...this.entries]) writeSync(fd, `${JSON.stringify(item)}\n`);
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
		}
	}

	/** 8 位的随机 id。万一重复了就再生成一个 */
	private newId(): string {
		for (;;) {
			const id = randomUUID().slice(0, 8);
			if (!this.byId.has(id)) return id;
		}
	}
}

function now(): string {
	return new Date().toISOString();
}
