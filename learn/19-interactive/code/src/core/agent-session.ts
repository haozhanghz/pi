// AgentSession：把 Agent（对话和循环）和 SessionManager（保存到文件）粘在一起，并负责上下文压缩。
// 各种模式（print、交互）都通过它来使用 agent。
// 对应 pi 的 packages/coding-agent/src/core/agent-session.ts。
import type { Agent, AgentEvent } from "../agent/index.ts";
import type { Model } from "../ai/index.ts";
import {
	type CompactionSettings,
	collectFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	effectiveSettings,
	estimateContextTokens,
	estimateTextTokens,
	estimateTokens,
	findCutPoint,
	formatFileLists,
	generateSummary,
	shouldCompact,
} from "./compaction.ts";
import type { MessageEntry, SessionManager } from "./session.ts";

export interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	/** 发给模型的 token（包括命中缓存的部分） */
	inputTokens: number;
	/** 模型生成的 token */
	outputTokens: number;
	/** 所有回复用掉的 token */
	tokens: number;
	/** 费用（美元） */
	cost: number;
}

/** manual：用户输入 /compact；threshold：上下文快满了，自动压缩 */
export type CompactionReason = "manual" | "threshold";

export interface CompactionResult {
	summary: string;
	/** 被总结掉的消息数 */
	summarizedMessages: number;
	tokensBefore: number;
	tokensAfter: number;
}

/** AgentSession 发出的事件：agent 的所有事件，加上压缩的开始和结束 */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "compaction_start"; reason: CompactionReason }
	| { type: "compaction_end"; reason: CompactionReason; result?: CompactionResult; error?: string };

export type AgentSessionListener = (event: AgentSessionEvent) => void | Promise<void>;

export interface AgentSessionOptions {
	compaction?: Partial<CompactionSettings>;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	compactionSettings: CompactionSettings;
	private readonly listeners = new Set<AgentSessionListener>();

	constructor(agent: Agent, sessionManager: SessionManager, options: AgentSessionOptions = {}) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };

		// 恢复之前的对话
		agent.state.messages = sessionManager.buildContext().messages;
		this.recordModel();

		// 每条消息完成时，先追加到会话文件，再转发给订阅者
		agent.subscribe(async (event) => {
			if (event.type === "message_end") sessionManager.appendMessage(event.message);
			await this.emit(event);
		});

		// 一次运行里可能有几十轮工具调用，上下文在运行中途就可能满了：每一轮开始之前检查一次
		agent.prepareNextTurn = async (_messages, signal) =>
			(await this.compactIfNeeded(signal)) ? agent.state.messages : undefined;
	}

	/** 订阅事件（agent 的事件和压缩的事件）。返回取消订阅的函数 */
	subscribe(listener: AgentSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(input: string): Promise<void> {
		await this.compactIfNeeded(); // 发送新的问题之前检查一次
		await this.agent.prompt(input);
	}

	/** 换一个模型，并记录到会话里（恢复会话时会用回这个模型） */
	setModel(model: Model): void {
		this.agent.state.model = model;
		this.recordModel();
	}

	/** 开始一个新的会话：清空对话，之后的消息写进一个新的文件 */
	newSession(): void {
		this.agent.reset(); // 正在运行时会抛出异常
		this.sessionManager.newSession();
		this.recordModel();
	}

	/**
	 * 估算当前上下文有多少 token。
	 * 刚压缩完、还没有新的回复时，最后一条回复报告的用量是压缩之前的，已经不准了，只能全部估算。
	 */
	getContextTokens(): number {
		const branch = this.sessionManager.getBranch();
		const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
		const hasFreshUsage = branch
			.slice(compactionIndex + 1)
			.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.totalTokens > 0);
		if (hasFreshUsage) return estimateContextTokens(this.agent.state.messages);

		// 全部估算：消息，再加上系统提示词和工具定义（它们也会发给模型）
		const { systemPrompt, tools } = this.agent.state;
		const toolDefinitions = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
		const fixed = estimateTextTokens(systemPrompt + toolDefinitions);
		return this.agent.state.messages.reduce((sum, message) => sum + estimateTokens(message), fixed);
	}

	/**
	 * 压缩上下文：把旧的消息总结成一段摘要，只保留最近的消息原文。
	 * 返回 undefined 表示没有可以压缩的内容（对话还很短）。
	 */
	async compact(
		options: { reason?: CompactionReason; customInstructions?: string; signal?: AbortSignal } = {},
	): Promise<CompactionResult | undefined> {
		const reason = options.reason ?? "manual";
		const model = this.agent.state.model;
		const settings = effectiveSettings(this.compactionSettings, model.contextWindow);

		// 这次处理的范围：从上次压缩时保留的第一条消息开始（没压缩过就从头开始）
		const branch = this.sessionManager.getBranch();
		const previous = this.sessionManager.getLatestCompaction();
		let start = 0;
		if (previous) {
			const kept = branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
			start = kept !== -1 ? kept : branch.indexOf(previous) + 1;
		}
		const entries = branch.slice(start).filter((entry): entry is MessageEntry => entry.type === "message");
		const cut = findCutPoint(
			entries.map((entry) => entry.message),
			settings.keepRecentTokens,
		);
		if (cut === 0) return undefined;

		await this.emit({ type: "compaction_start", reason });
		try {
			const toSummarize = entries.slice(0, cut).map((entry) => entry.message);
			const tokensBefore = this.getContextTokens();
			const { text } = await generateSummary(toSummarize, model, {
				apiKey: this.agent.getApiKey(model.provider),
				signal: options.signal,
				previousSummary: previous?.summary,
				customInstructions: options.customInstructions,
				maxTokens: Math.floor(settings.reserveTokens * 0.8), // 总结要放得进预留的空间
				streamFn: this.agent.streamFn,
			});
			const files = collectFileLists(toSummarize, previous?.details);
			const summary = text + formatFileLists(files);

			this.sessionManager.appendCompaction(summary, entries[cut].id, tokensBefore, files);
			this.agent.state.messages = this.sessionManager.buildContext().messages;

			const result: CompactionResult = {
				summary,
				summarizedMessages: toSummarize.length,
				tokensBefore,
				tokensAfter: this.getContextTokens(),
			};
			await this.emit({ type: "compaction_end", reason, result });
			return result;
		} catch (error) {
			await this.emit({ type: "compaction_end", reason, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	getStats(): SessionStats {
		const stats: SessionStats = {
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			tokens: 0,
			cost: 0,
		};
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") stats.userMessages++;
			else if (message.role === "toolResult") stats.toolCalls++;
			else {
				stats.assistantMessages++;
				stats.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
				stats.outputTokens += message.usage.output;
				stats.tokens += message.usage.totalTokens;
				stats.cost += message.usage.cost.total;
			}
		}
		return stats;
	}

	/** 上下文快满了就压缩。自动压缩失败不应该打断用户的请求：错误已经通过 compaction_end 事件报告了 */
	private async compactIfNeeded(signal?: AbortSignal): Promise<boolean> {
		const model = this.agent.state.model;
		const settings = effectiveSettings(this.compactionSettings, model.contextWindow);
		if (!shouldCompact(this.getContextTokens(), model.contextWindow, settings)) return false;
		try {
			return (await this.compact({ reason: "threshold", signal })) !== undefined;
		} catch {
			return false;
		}
	}

	private async emit(event: AgentSessionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}

	/** 当前的模型和会话里记录的不一样时，追加一条 model_change */
	private recordModel(): void {
		const recorded = this.sessionManager.buildContext().model;
		const { provider, id } = this.agent.state.model;
		if (recorded?.provider !== provider || recorded.modelId !== id) {
			this.sessionManager.appendModelChange(provider, id);
		}
	}
}
