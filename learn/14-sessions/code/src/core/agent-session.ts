// AgentSession：把 Agent（对话和循环）和 SessionManager（保存到文件）粘在一起。
// 各种模式（print、交互）都通过它来使用 agent。
// 对应 pi 的 packages/coding-agent/src/core/agent-session.ts。
import type { Agent } from "../agent/index.ts";
import type { Model } from "../ai/index.ts";
import type { SessionManager } from "./session.ts";

export interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	/** 所有回复用掉的 token */
	tokens: number;
	/** 费用（美元） */
	cost: number;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;

	constructor(agent: Agent, sessionManager: SessionManager) {
		this.agent = agent;
		this.sessionManager = sessionManager;

		// 恢复之前的对话
		agent.state.messages = sessionManager.buildContext().messages;
		this.recordModel();

		// 每条消息完成时，追加到会话文件。这是 agent 的第一个订阅者，所以在界面显示之前就已经保存了
		agent.subscribe((event) => {
			if (event.type === "message_end") sessionManager.appendMessage(event.message);
		});
	}

	prompt(input: string): Promise<void> {
		return this.agent.prompt(input);
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

	getStats(): SessionStats {
		const stats: SessionStats = { userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: 0, cost: 0 };
		for (const message of this.agent.state.messages) {
			if (message.role === "user") stats.userMessages++;
			else if (message.role === "toolResult") stats.toolCalls++;
			else {
				stats.assistantMessages++;
				stats.tokens += message.usage.totalTokens;
				stats.cost += message.usage.cost.total;
			}
		}
		return stats;
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
