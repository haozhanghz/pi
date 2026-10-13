// 助手的回复：文字用 Markdown 渲染，思考过程用灰色斜体；出错、被打断、被截断时，在最后显示一行说明。
// 工具调用不在这里显示，而是由 ToolExecutionView 单独显示（它要显示执行的结果）。
// 对应 pi 的 packages/coding-agent/src/modes/interactive/components/assistant-message.ts。
import type { AssistantMessage } from "../../../ai/index.ts";
import { Container, gray, italic, Markdown, red, Spacer, Text, yellow } from "../../../tui/index.ts";

export class AssistantMessageView extends Container {
	constructor(message: AssistantMessage) {
		super();
		this.update(message);
	}

	/** 用最新的消息重建内容。流式输出时，每收到一块数据就调用一次 */
	update(message: AssistantMessage): void {
		this.clear();
		for (const block of message.content) {
			if (block.type === "thinking" && block.thinking.trim() !== "") {
				this.addChild(new Spacer(1));
				this.addChild(new Text(gray(italic(block.thinking.trim()))));
			} else if (block.type === "text" && block.text.trim() !== "") {
				this.addChild(new Spacer(1));
				this.addChild(new Markdown(block.text.trim()));
			}
		}
		if (message.stopReason === "error") this.addNotice(red(`出错了：${message.errorMessage ?? "未知错误"}`));
		else if (message.stopReason === "aborted") this.addNotice(yellow("已打断"));
		else if (message.stopReason === "length") this.addNotice(yellow("回答太长，被截断了"));
	}

	private addNotice(text: string): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(text));
	}
}
