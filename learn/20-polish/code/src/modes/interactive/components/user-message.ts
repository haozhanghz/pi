// 用户的消息：前面一个青色的 >，折行后的行和文字对齐。
// 对应 pi 的 packages/coding-agent/src/modes/interactive/components/user-message.ts（pi 用背景色把用户的消息框起来）。
import { type Component, cyan, truncateToWidth, wrapText } from "../../../tui/index.ts";

export class UserMessageView implements Component {
	private readonly text: string;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const body = wrapText(this.text, width - 3).map((line, index) => (index === 0 ? ` ${cyan(">")} ` : "   ") + line);
		const lines = ["", ...body.map((line) => truncateToWidth(line, width))];
		this.cache = { width, lines };
		return lines;
	}
}
