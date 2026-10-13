// 确认对话框：显示一个问题，按 y 允许，按 n 或 Esc 拒绝。它临时出现在输入框的位置上。
// pi 没有内置这个对话框：它的危险命令确认由扩展实现（examples/extensions/permission-gate.ts），用的是选择菜单。
import {
	bold,
	type Component,
	type Focusable,
	formatKeyId,
	getKeys,
	matchesAction,
	truncateToWidth,
	wrapText,
	yellow,
} from "../../../tui/index.ts";

export class ConfirmDialog implements Component, Focusable {
	focused = false;
	private readonly title: string;
	private readonly detail: string;
	private readonly onAnswer: (allowed: boolean) => void;

	constructor(title: string, detail: string, onAnswer: (allowed: boolean) => void) {
		this.title = title;
		this.detail = detail;
		this.onAnswer = onAnswer;
	}

	handleInput(data: string): void {
		if (matchesAction(data, "dialog.allow")) this.onAnswer(true);
		else if (matchesAction(data, "dialog.deny")) this.onAnswer(false);
	}

	render(width: number): string[] {
		const border = yellow("─".repeat(width));
		const keysOf = (action: "dialog.allow" | "dialog.deny") => bold(getKeys(action).map(formatKeyId).join("/"));
		const keys = `${keysOf("dialog.allow")} 允许    ${keysOf("dialog.deny")} 拒绝`;
		return [
			border,
			truncateToWidth(` ${bold(yellow(this.title))}`, width),
			...wrapText(this.detail, width - 2).map((line) => truncateToWidth(` ${line}`, width)),
			truncateToWidth(` ${keys}`, width),
			border,
		];
	}
}
