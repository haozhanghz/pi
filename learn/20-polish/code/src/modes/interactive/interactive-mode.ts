// 交互模式：mini-pi 的终端界面。上面是对话记录，下面是输入框和状态栏。
// 它做两件事：把 AgentSession 的每个事件变成界面上的变化；把用户的输入和按键变成对 agent 的操作。
// 对应 pi 的 packages/coding-agent/src/modes/interactive/interactive-mode.ts（七千多行，我们实现它的核心部分）。
import type { BeforeToolCall } from "../../agent/index.ts";
import { getApiKey, getProvider, type Message, PROVIDERS, resolveModel } from "../../ai/index.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { APP_NAME, VERSION } from "../../core/config.ts";
import { isDangerousCommand } from "../../core/dangerous.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../core/settings.ts";
import {
	type Component,
	Container,
	cyan,
	dim,
	Editor,
	formatKeyId,
	getKeys,
	type KeyAction,
	Loader,
	matchesAction,
	ProcessTerminal,
	red,
	SelectList,
	Spacer,
	type Terminal,
	Text,
	TUI,
	visibleWidth,
	yellow,
} from "../../tui/index.ts";
import { AssistantMessageView } from "./components/assistant-message.ts";
import { ConfirmDialog } from "./components/confirm-dialog.ts";
import { Footer, shortenPath } from "./components/footer.ts";
import { ToolExecutionView } from "./components/tool-execution.ts";
import { UserMessageView } from "./components/user-message.ts";

export interface InteractiveOptions {
	/** 默认是真正的终端。测试时换成 VirtualTerminal */
	terminal?: Terminal;
	/** 工作目录，显示在状态栏里。默认是 process.cwd() */
	cwd?: string;
	/** 执行危险的命令之前先问用户，默认 true */
	confirmDangerous?: boolean;
	/** 启动后立刻依次发送的消息（命令行里给的消息） */
	initialMessages?: string[];
	/** 已加载的项目说明文件，显示在标题下面 */
	contextFiles?: string[];
	/** 当前的设置（/settings 显示它们） */
	settings?: Settings;
	/** 设置文件的位置 */
	settingsPath?: string;
	/** 启动时要提醒用户的问题（比如设置文件写错了） */
	warnings?: string[];
}

/** 斜杠命令：在输入框里输入 /名字 运行 */
interface SlashCommand {
	name: string;
	description: string;
	run: (args: string) => void;
}

/** 两次 Ctrl+C 的间隔不超过这么多毫秒，就退出 */
const DOUBLE_PRESS_MS = 500;

/** 压缩之后的总结也是一条用户消息，以这句话开头（见 core/compaction.ts） */
const SUMMARY_PREFIX = "之前的对话已经被压缩成了";

/** 某个动作的第一个按键，显示在提示里。用户改了快捷键，提示也跟着变 */
function keyOf(action: KeyAction): string {
	return formatKeyId(getKeys(action)[0] ?? "");
}

function textOf(message: Message): string {
	return message.role === "user" ? message.content : "";
}

/** 按显示宽度补齐，用来对齐两列文字 */
function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** 运行交互模式，直到用户退出 */
export function runInteractiveMode(session: AgentSession, options: InteractiveOptions = {}): Promise<void> {
	return new InteractiveMode(session, options).run();
}

class InteractiveMode {
	private readonly session: AgentSession;
	private readonly options: InteractiveOptions;
	private readonly tui: TUI;
	/** 对话记录 */
	private readonly chat = new Container();
	/** 排队等待处理的消息 */
	private readonly pending = new Container();
	/** "正在工作"的动画 */
	private readonly status = new Container();
	/** 输入框所在的位置。确认对话框会临时替换掉输入框 */
	private readonly editorArea = new Container();
	private readonly editor = new Editor();
	/** 输入框下面的命令提示（输入 / 时显示） */
	private readonly hints = new Container();
	private readonly footer: Footer;
	private loader: Loader | undefined;
	/** 正在流式输出的助手消息 */
	private streaming: AssistantMessageView | undefined;
	/** 正在执行的工具，按工具调用的 id 查找 */
	private readonly runningTools = new Map<string, ToolExecutionView>();
	/** 是否正在处理用户的消息（包括发给模型之前的上下文压缩） */
	private busy = false;
	private exiting = false;
	private lastCtrlC = 0;
	private unsubscribe: () => void = () => {};
	private finish: () => void = () => {};

	private readonly commands: SlashCommand[] = [
		{ name: "help", description: "显示所有命令和快捷键", run: () => this.showHelp() },
		{ name: "model", description: "切换模型；/model 服务商/模型 直接切换", run: (args) => this.selectModel(args) },
		{ name: "compact", description: "压缩上下文，可以附加要求，比如 /compact 保留所有文件路径", run: (args) => void this.compact(args || undefined) },
		{ name: "new", description: "开始新的会话", run: () => this.newSession() },
		{ name: "session", description: "显示当前会话的信息", run: () => this.showSessionInfo() },
		{ name: "settings", description: "显示设置文件的位置和当前的设置", run: () => this.showSettings() },
		{ name: "quit", description: "退出", run: () => void this.exit() },
	];

	constructor(session: AgentSession, options: InteractiveOptions) {
		this.session = session;
		this.options = options;
		this.tui = new TUI(options.terminal ?? new ProcessTerminal());
		this.footer = new Footer(session, options.cwd ?? process.cwd());

		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.createHeader());
		this.tui.addChild(this.chat);
		this.tui.addChild(this.pending);
		this.tui.addChild(this.status);
		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.editorArea);
		this.tui.addChild(this.hints);
		this.tui.addChild(this.footer);
		this.editorArea.addChild(this.editor);
		this.tui.setFocus(this.editor);
	}

	run(): Promise<void> {
		const done = new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		this.unsubscribe = this.session.subscribe(this.handleEvent);
		this.tui.addInputListener(this.handleKey);
		this.editor.onSubmit = (text) => this.submit(text);
		this.editor.onChange = (text) => this.updateHints(text);
		if (this.options.confirmDangerous ?? true) this.session.agent.beforeToolCall = this.confirmDangerous;

		this.renderHistory(this.session.agent.state.messages);
		for (const warning of this.options.warnings ?? []) this.addNotice(yellow(warning));
		this.tui.start();
		void this.sendInitialMessages();
		return done;
	}

	private createHeader(): Component {
		const lines = [
			`${cyan(APP_NAME)} ${dim(VERSION)}`,
			...(this.options.contextFiles ?? []).map((path) => dim(`已加载 ${shortenPath(path)}`)),
			dim(
				`${keyOf("app.interrupt")} 打断 · ${keyOf("app.clear")} 清空输入，按两次退出 · ${keyOf("app.exit")} 退出 · ` +
					"运行时回车是插话，+ 开头是排队 · /help 查看所有命令",
			),
		];
		return new Text(lines.join("\n"));
	}

	// ---------- agent 的事件 → 界面的变化 ----------

	private readonly handleEvent = (event: AgentSessionEvent): void => {
		switch (event.type) {
			case "agent_start":
				this.showLoader("正在思考……");
				break;
			case "message_start":
				if (event.message.role === "user") {
					this.chat.addChild(this.createUserMessage(event.message.content));
					this.updatePending(); // 排队的消息可能刚被取走
				} else if (event.message.role === "assistant") {
					this.streaming = new AssistantMessageView(event.message);
					this.chat.addChild(this.streaming);
				}
				break;
			case "message_update":
				this.streaming?.update(event.message);
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.streaming?.update(event.message);
					this.streaming = undefined;
					this.footer.update();
				}
				break;
			case "tool_execution_start": {
				const view = new ToolExecutionView(event.toolName, event.args);
				this.runningTools.set(event.toolCallId, view);
				this.chat.addChild(view);
				this.showLoader(`正在执行 ${event.toolName}……`);
				break;
			}
			case "tool_execution_update":
				this.runningTools.get(event.toolCallId)?.setPartialResult(event.partialResult);
				break;
			case "tool_execution_end":
				this.runningTools.get(event.toolCallId)?.setResult(event.result, event.isError);
				this.runningTools.delete(event.toolCallId);
				if (this.runningTools.size === 0) this.showLoader("正在思考……");
				break;
			case "agent_end":
				this.hideLoader();
				this.streaming = undefined;
				this.runningTools.clear();
				this.footer.update();
				break;
			case "compaction_start":
				this.showLoader(event.reason === "overflow" ? "上下文超出了模型的上限，正在压缩……" : "正在压缩上下文……");
				break;
			case "retry_start":
				this.showLoader(`出错了，${event.delayMs / 1000} 秒后第 ${event.attempt}/${event.maxRetries} 次重试……`);
				break;
			case "retry_end":
				if (!event.success) this.addNotice(red(`重试了 ${event.attempt} 次，还是失败了：${event.error}`));
				break;
			case "compaction_end":
				if (event.result) {
					const { summarizedMessages, tokensBefore, tokensAfter } = event.result;
					this.addNotice(dim(`已压缩上下文：总结了 ${summarizedMessages} 条消息，约 ${tokensBefore} → ${tokensAfter} tokens`));
				} else {
					this.addNotice(red(`压缩失败：${event.error}`));
				}
				if (!this.session.agent.state.isStreaming) this.hideLoader();
				this.footer.update();
				break;
		}
		this.tui.requestRender();
	};

	// ---------- 用户的输入 → 对 agent 的操作 ----------

	private submit(text: string): void {
		if (text === "") return;
		this.editor.addToHistory(text);
		this.hints.clear();
		const command = this.findCommand(text);
		if (command) {
			command.run(text.slice(command.name.length + 1).trim());
		} else if (this.busy) {
			// 正在运行：普通的消息是插话，以 + 开头的是排队
			if (text.startsWith("+")) this.session.agent.followUp(text.slice(1).trim());
			else this.session.agent.steer(text);
			this.updatePending();
		} else {
			void this.prompt(text);
		}
		this.tui.requestRender();
	}

	private async prompt(text: string): Promise<void> {
		this.busy = true;
		let next: string | undefined = text;
		while (next !== undefined && !this.exiting) {
			try {
				await this.session.prompt(next);
			} catch (error) {
				this.addNotice(red(`程序出错：${error instanceof Error ? error.message : String(error)}`));
			}
			// agent 快结束的时候才插话的消息，可能没赶上这一次运行：接着处理，不能丢掉
			const { steering, followUp } = this.session.agent.queuedMessages;
			const leftover = [...steering, ...followUp].map(textOf);
			this.session.agent.clearQueues();
			next = leftover.length > 0 ? leftover.join("\n\n") : undefined;
		}
		this.busy = false;
		this.updatePending();
		this.tui.requestRender();
	}

	private async sendInitialMessages(): Promise<void> {
		for (const message of this.options.initialMessages ?? []) {
			if (this.exiting) return;
			this.editor.addToHistory(message);
			await this.prompt(message);
		}
	}

	private newSession(): void {
		if (this.busy) {
			this.addNotice(yellow(`agent 正在运行。先按 ${keyOf("app.interrupt")} 打断，或者等它完成。`));
			return;
		}
		this.session.newSession();
		this.chat.clear();
		this.addNotice(dim("已开始新的会话。"));
		this.footer.update();
	}

	private async compact(customInstructions: string | undefined): Promise<void> {
		if (this.busy) {
			this.addNotice(yellow("agent 正在运行，等它完成之后再压缩。"));
			return;
		}
		this.busy = true;
		try {
			const result = await this.session.compact({ customInstructions });
			if (!result) this.addNotice(dim("没有可以压缩的内容：对话还很短。"));
		} catch {
			// 错误已经通过 compaction_end 事件显示了
		}
		this.busy = false;
		this.hideLoader();
		this.tui.requestRender();
	}

	/** 全局快捷键：在输入框之前处理。返回 true 表示处理了 */
	private readonly handleKey = (data: string): boolean => {
		if (matchesAction(data, "app.interrupt") && this.busy) {
			this.interrupt();
			return true;
		}
		if (matchesAction(data, "app.clear")) {
			const now = Date.now();
			if (now - this.lastCtrlC < DOUBLE_PRESS_MS) void this.exit();
			else this.editor.setText("");
			this.lastCtrlC = now;
			return true;
		}
		if (matchesAction(data, "app.exit") && this.editor.getText() === "") {
			void this.exit();
			return true;
		}
		if (matchesAction(data, "app.complete") && this.completeCommand()) return true;
		return false;
	};

	/** 打断：取消当前的运行。还在排队的消息放回输入框，免得丢失 */
	private interrupt(): void {
		const agent = this.session.agent;
		const { steering, followUp } = agent.queuedMessages;
		const queued = [...steering, ...followUp].map(textOf);
		agent.clearQueues();
		if (queued.length > 0) {
			this.editor.setText([...queued, this.editor.getText()].filter((text) => text !== "").join("\n\n"));
		}
		this.session.abort(); // 也会取消正在等待的自动重试
		this.updatePending();
	}

	private async exit(): Promise<void> {
		if (this.exiting) return;
		this.exiting = true;
		this.session.abort();
		await this.session.agent.waitForIdle();
		this.hideLoader();
		this.tui.stop();
		this.unsubscribe();

		const stats = this.session.getStats();
		const saved = this.session.sessionManager.sessionFile;
		const lines = [
			`本次会话：${stats.userMessages} 个问题，调用工具 ${stats.toolCalls} 次，共 ${stats.tokens} tokens，$${stats.cost.toFixed(4)}`,
		];
		if (saved && stats.userMessages > 0) lines.push(`会话已保存，下次用 ${APP_NAME} -c 继续：${saved}`);
		this.tui.terminal.write(`${lines.map((line) => dim(line)).join("\r\n")}\r\n`);
		this.finish();
	}

	/** 执行危险的命令之前，用对话框问用户 */
	private readonly confirmDangerous: BeforeToolCall = async ({ toolCall, args }, signal) => {
		if (toolCall.name !== "bash") return undefined;
		const command = String(args.command);
		if (!isDangerousCommand(command)) return undefined;
		const allowed = await this.ask("这个命令可能有危险，允许执行吗？", command, signal);
		return allowed ? undefined : { block: true, reason: "用户拒绝执行这个命令。" };
	};

	/** 把输入框换成确认对话框，等用户回答。运行被打断时当作拒绝 */
	private ask(title: string, detail: string, signal?: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			const answer = (allowed: boolean) => {
				signal?.removeEventListener("abort", onAbort);
				this.editorArea.clear();
				this.editorArea.addChild(this.editor);
				this.tui.setFocus(this.editor);
				resolve(allowed);
			};
			const onAbort = () => answer(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			const dialog = new ConfirmDialog(title, detail, answer);
			this.editorArea.clear();
			this.editorArea.addChild(dialog);
			this.tui.setFocus(dialog);
			this.tui.requestRender();
		});
	}

	// ---------- 斜杠命令 ----------

	/** 输入的内容是不是一个斜杠命令。不认识的 /xxx 当作普通的消息发给模型（比如 "/usr/bin 里有什么"） */
	private findCommand(text: string): SlashCommand | undefined {
		if (!text.startsWith("/")) return undefined;
		const name = text.slice(1).split(/\s/)[0];
		return this.commands.find((command) => command.name === name);
	}

	/** 输入 / 开头的内容时，在输入框下面列出匹配的命令 */
	private updateHints(text: string): void {
		this.hints.clear();
		if (!text.startsWith("/") || /\s/.test(text)) return;
		const matches = this.commands.filter((command) => `/${command.name}`.startsWith(text));
		const width = Math.max(...matches.map((command) => command.name.length + 1));
		for (const command of matches) {
			this.hints.addChild(new Text(`${cyan(padEnd(`/${command.name}`, width))}  ${dim(command.description)}`));
		}
	}

	/** Tab：把命令补全成第一个匹配的命令。返回是否补全了 */
	private completeCommand(): boolean {
		const text = this.editor.getText();
		if (!text.startsWith("/") || /\s/.test(text)) return false;
		const match = this.commands.find((command) => `/${command.name}`.startsWith(text));
		if (!match) return false;
		this.editor.setText(`/${match.name} `);
		this.hints.clear();
		return true;
	}

	private showHelp(): void {
		const width = Math.max(...this.commands.map((command) => command.name.length + 1));
		const keys: [string, string][] = [
			[keyOf("app.interrupt"), "打断正在运行的 agent"],
			[keyOf("app.clear"), "清空输入框；很快地按两次退出"],
			[keyOf("app.exit"), "退出（输入框为空时）"],
			[getKeys("input.newLine").map(formatKeyId).join(" / "), "换行（也可以在行尾输入 \\ 再按回车）"],
			["↑ ↓", "在第一行、最后一行时翻看输入历史"],
			[keyOf("app.complete"), "补全命令"],
		];
		const keyWidth = Math.max(...keys.map(([key]) => visibleWidth(key)));
		const lines = [
			"命令：",
			...this.commands.map((command) => `  ${cyan(padEnd(`/${command.name}`, width))}  ${command.description}`),
			"",
			"快捷键：",
			...keys.map(([key, description]) => `  ${cyan(padEnd(key, keyWidth))}  ${description}`),
			"",
			"agent 运行时：直接回车是插话（当前这一步完成后交给模型），以 + 开头是排队（等它做完再处理）。",
		];
		this.addNotice(lines.join("\n"));
	}

	/** /model：从列表里选一个模型。也可以直接写 /model 服务商/模型 */
	private selectModel(spec: string): void {
		if (this.busy) {
			this.addNotice(yellow("agent 正在运行，等它完成之后再切换模型。"));
			return;
		}
		if (spec !== "") {
			this.switchModel(spec);
			return;
		}
		const current = this.session.agent.state.model;
		const currentSpec = `${current.provider}/${current.id}`;
		const items = PROVIDERS.flatMap((provider) =>
			provider.models.map((model) => ({
				value: `${provider.id}/${model.id}`,
				label: `${provider.id}/${model.id}`,
				description: getApiKey(provider.id) ? provider.name : `${provider.name}（没有 API key）`,
			})),
		);
		// 当前的模型可能不在表里（比如用 LLM_BASE_URL 指定的模型），放在最前面
		if (!items.some((item) => item.value === currentSpec)) items.unshift({ value: currentSpec, label: currentSpec, description: "当前" });
		const list = new SelectList(items, { maxVisible: 10, selectedValue: currentSpec });
		list.onSelect = (item) => {
			this.closeSelector();
			this.switchModel(item.value);
		};
		list.onCancel = () => this.closeSelector();
		this.showSelector(list);
	}

	private switchModel(spec: string): void {
		try {
			const model = resolveModel(spec);
			this.session.setModel(model);
			this.footer.update();
			const provider = getProvider(model.provider);
			const missingKey = provider?.apiKeyEnv && !getApiKey(model.provider);
			this.addNotice(
				missingKey
					? yellow(`已切换到 ${spec}，但是没有找到 API key：请设置环境变量 ${provider.apiKeyEnv}`)
					: dim(`已切换到 ${spec}`),
			);
		} catch (error) {
			this.addNotice(red(error instanceof Error ? error.message : String(error)));
		}
	}

	/** 把输入框换成一个选择列表（和 pi 的 showSelector 一样） */
	private showSelector(component: SelectList): void {
		this.editorArea.clear();
		this.editorArea.addChild(component);
		this.tui.setFocus(component);
		this.tui.requestRender();
	}

	private closeSelector(): void {
		this.editorArea.clear();
		this.editorArea.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private showSessionInfo(): void {
		const stats = this.session.getStats();
		const { model } = this.session.agent.state;
		const contextTokens = this.session.getContextTokens();
		const percent = Math.round((contextTokens / model.contextWindow) * 100);
		this.addNotice(
			[
				`会话文件：${this.session.sessionManager.sessionFile ?? "不保存（--no-session）"}`,
				`模型：${model.provider}/${model.id}`,
				`消息：${stats.userMessages} 个问题，${stats.assistantMessages} 条回复，调用工具 ${stats.toolCalls} 次`,
				`token：输入 ${stats.inputTokens}，输出 ${stats.outputTokens}；费用 $${stats.cost.toFixed(4)}`,
				`上下文：约 ${contextTokens} / ${model.contextWindow} tokens（${percent}%）`,
			].join("\n"),
		);
	}

	private showSettings(): void {
		const settings = this.options.settings ?? DEFAULT_SETTINGS;
		this.addNotice(
			[
				`设置文件：${this.options.settingsPath ?? "（未知）"}`,
				"当前生效的设置（修改设置文件之后，重新启动 mini-pi 生效）：",
				...JSON.stringify(settings, null, 2).split("\n").map((line) => dim(line)),
			].join("\n"),
		);
	}

	// ---------- 界面的小部件 ----------

	/** 恢复会话时，把之前的对话显示出来 */
	private renderHistory(messages: Message[]): void {
		const tools = new Map<string, ToolExecutionView>();
		for (const message of messages) {
			if (message.role === "user") {
				this.chat.addChild(this.createUserMessage(message.content));
			} else if (message.role === "assistant") {
				this.chat.addChild(new AssistantMessageView(message));
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const view = new ToolExecutionView(block.name, block.arguments);
					tools.set(block.id, view);
					this.chat.addChild(view);
				}
			} else {
				tools.get(message.toolCallId)?.setResult({ content: message.content, details: message.details }, message.isError);
				tools.delete(message.toolCallId);
			}
		}
		// 没有结果的工具调用：上次运行时被打断了
		for (const view of tools.values()) view.setResult({ content: [{ type: "text", text: "没有执行（被打断了）" }] }, true);
	}

	private createUserMessage(text: string): Component {
		if (text.startsWith(SUMMARY_PREFIX)) return new Text(dim("（更早的对话已经压缩成了一份总结）"), 1, 1);
		return new UserMessageView(text);
	}

	private addNotice(text: string): void {
		this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(text));
		this.tui.requestRender();
	}

	private updatePending(): void {
		this.pending.clear();
		const { steering, followUp } = this.session.agent.queuedMessages;
		if (steering.length + followUp.length === 0) return;
		this.pending.addChild(new Spacer(1));
		for (const message of steering) this.pending.addChild(new Text(dim(`插话：${textOf(message)}`)));
		for (const message of followUp) this.pending.addChild(new Text(dim(`排队：${textOf(message)}`)));
	}

	private showLoader(message: string): void {
		const text = `${message}（${keyOf("app.interrupt")} 打断）`;
		if (this.loader) {
			this.loader.setMessage(text);
			return;
		}
		this.loader = new Loader(this.tui, text);
		this.status.addChild(new Spacer(1));
		this.status.addChild(this.loader);
		this.loader.start();
	}

	private hideLoader(): void {
		this.loader?.stop();
		this.loader = undefined;
		this.status.clear();
	}
}
