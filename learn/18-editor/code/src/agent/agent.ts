// Agent 类：把 runAgentLoop 包装成一个"有状态的对象"。
// 它保存对话历史，管理"正在运行"的状态，让多个地方订阅事件，支持取消、插话和排队。
// 对应 pi 的 packages/agent/src/agent.ts。
import { getApiKey, type Message, type Model } from "../ai/index.ts";
import { runAgentLoop } from "./loop.ts";
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentTool,
	BeforeToolCall,
	PrepareNextTurn,
	StreamFunction,
	ToolExecutionMode,
} from "./types.ts";

/** agent 的状态。界面随时可以读取它 */
export interface AgentState {
	systemPrompt: string;
	model: Model;
	tools: AgentTool[];
	/** 完整的对话历史 */
	messages: Message[];
	/** 是否正在运行 */
	isStreaming: boolean;
	/** 正在流式接收的消息（还没完成）。界面用它显示"正在输入"的内容 */
	streamingMessage?: Message;
	/** 正在执行的工具调用的 id */
	pendingToolCalls: Set<string>;
	/** 最近一次运行出错（或被取消）时的错误信息 */
	errorMessage?: string;
}

export interface AgentOptions {
	model: Model;
	systemPrompt?: string;
	tools?: AgentTool[];
	/** 之前的对话（比如从文件里恢复的会话） */
	messages?: Message[];
	/** 根据服务商获取 API key。默认从环境变量读取（ai 层的 getApiKey） */
	getApiKey?: (provider: string) => string | undefined;
	streamFn?: StreamFunction;
	toolExecution?: ToolExecutionMode;
	maxTokens?: number;
	temperature?: number;
	/** 每个工具调用执行之前调用，可以阻止它（比如让用户确认危险的命令） */
	beforeToolCall?: BeforeToolCall;
	/** 每一轮开始之前调用，可以替换对话（比如压缩上下文） */
	prepareNextTurn?: PrepareNextTurn;
}

export type AgentListener = (event: AgentEvent) => void | Promise<void>;

export class Agent {
	readonly state: AgentState;
	getApiKey: (provider: string) => string | undefined;
	streamFn?: StreamFunction;
	toolExecution: ToolExecutionMode;
	maxTokens?: number;
	temperature?: number;
	beforeToolCall?: BeforeToolCall;
	prepareNextTurn?: PrepareNextTurn;

	private readonly listeners = new Set<AgentListener>();
	private readonly steeringQueue: Message[] = [];
	private readonly followUpQueue: Message[] = [];
	/** 当前的运行。undefined 表示空闲 */
	private activeRun?: { promise: Promise<void>; abortController: AbortController };

	constructor(options: AgentOptions) {
		this.state = {
			systemPrompt: options.systemPrompt ?? "",
			model: options.model,
			tools: options.tools ?? [],
			messages: [...(options.messages ?? [])],
			isStreaming: false,
			pendingToolCalls: new Set(),
		};
		this.getApiKey = options.getApiKey ?? getApiKey;
		this.streamFn = options.streamFn;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.maxTokens = options.maxTokens;
		this.temperature = options.temperature;
		this.beforeToolCall = options.beforeToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
	}

	/** 订阅事件。返回一个函数，调用它取消订阅 */
	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 发送一条消息，运行 agent，直到它完成（包括处理所有插话和排队的消息）。
	 * 正在运行时不能调用：请用 steer() 或 followUp()。
	 */
	async prompt(input: string | Message | Message[]): Promise<void> {
		if (this.activeRun) {
			throw new Error("agent 正在运行。请用 steer() 或 followUp() 排队，或者等它完成。");
		}
		const prompts = typeof input === "string" ? [userMessage(input)] : Array.isArray(input) ? input : [input];

		const abortController = new AbortController();
		let finish = () => {};
		const promise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.activeRun = { promise, abortController };
		this.state.isStreaming = true;
		this.state.errorMessage = undefined;

		try {
			await runAgentLoop(
				prompts,
				{ systemPrompt: this.state.systemPrompt, messages: [...this.state.messages], tools: [...this.state.tools] },
				this.createLoopConfig(),
				(event) => this.handleEvent(event),
				abortController.signal,
			);
		} finally {
			// 不管成功还是出错，都要回到空闲状态，否则 agent 就再也不能用了
			this.state.isStreaming = false;
			this.state.streamingMessage = undefined;
			this.state.pendingToolCalls = new Set();
			this.activeRun = undefined;
			finish();
		}
	}

	/** 插话：当前这一轮的工具执行完之后、下一次请求模型之前，把这条消息加入对话 */
	steer(input: string | Message): void {
		this.steeringQueue.push(typeof input === "string" ? userMessage(input) : input);
	}

	/** 排队：等 agent 本来要停下时，再处理这条消息 */
	followUp(input: string | Message): void {
		this.followUpQueue.push(typeof input === "string" ? userMessage(input) : input);
	}

	/** 还没处理的插话和排队消息（界面可以把它们显示出来） */
	get queuedMessages(): { steering: Message[]; followUp: Message[] } {
		return { steering: [...this.steeringQueue], followUp: [...this.followUpQueue] };
	}

	/** 清空插话和排队的消息 */
	clearQueues(): void {
		this.steeringQueue.length = 0;
		this.followUpQueue.length = 0;
	}

	/** 取消当前的运行（空闲时什么也不做） */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/** 等待当前的运行结束（空闲时立即返回） */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** 清空对话历史和队列，开始新的对话 */
	reset(): void {
		if (this.activeRun) throw new Error("agent 正在运行，不能重置。请先 abort() 并等待 waitForIdle()。");
		this.state.messages = [];
		this.state.errorMessage = undefined;
		this.clearQueues();
	}

	private createLoopConfig(): AgentLoopConfig {
		return {
			model: this.state.model,
			apiKey: this.getApiKey(this.state.model.provider),
			streamFn: this.streamFn,
			toolExecution: this.toolExecution,
			maxTokens: this.maxTokens,
			temperature: this.temperature,
			beforeToolCall: this.beforeToolCall,
			prepareNextTurn: this.prepareNextTurn,
			// 每次只取一条：用户连续排了几条消息时，agent 一条一条地处理
			getSteeringMessages: () => this.steeringQueue.splice(0, 1),
			getFollowUpMessages: () => this.followUpQueue.splice(0, 1),
		};
	}

	/** 根据事件更新状态，然后通知所有订阅者 */
	private async handleEvent(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.state.streamingMessage = event.message;
				break;
			case "message_end":
				// 对话历史就是这样一条条记录下来的：每条消息完成时加入历史
				this.state.streamingMessage = undefined;
				this.state.messages.push(event.message);
				break;
			case "tool_execution_start":
				this.state.pendingToolCalls.add(event.toolCallId);
				break;
			case "tool_execution_end":
				this.state.pendingToolCalls.delete(event.toolCallId);
				break;
			case "turn_end":
				if (event.message.errorMessage) this.state.errorMessage = event.message.errorMessage;
				break;
		}
		for (const listener of this.listeners) {
			await listener(event);
		}
	}
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}
