// 文字组件：显示一段文字，按宽度自动换行。对应 pi 的 packages/tui/src/components/text.ts。
import type { Component } from "../tui.ts";
import { wrapText } from "../width.ts";

export class Text implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	/** 缓存上一次的结果。界面每秒可能重画几十次，而大部分组件根本没变，没必要每次都重新换行 */
	private cache: { text: string; width: number; lines: string[] } | undefined;

	/**
	 * @param paddingX 左边空几列（右边留出同样的宽度）
	 * @param paddingY 上下各空几行
	 */
	constructor(text = "", paddingX = 1, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache && this.cache.text === this.text && this.cache.width === width) return this.cache.lines;

		const lines: string[] = [];
		if (this.text !== "") {
			// 窗口很窄时减少留白，保证至少有一列可以放文字
			const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
			const margin = " ".repeat(paddingX);
			for (let i = 0; i < this.paddingY; i++) lines.push("");
			// 制表符在终端里的宽度不确定，换成空格
			for (const line of wrapText(this.text.replaceAll("\t", "   "), width - paddingX * 2)) lines.push(margin + line);
			for (let i = 0; i < this.paddingY; i++) lines.push("");
		}
		this.cache = { text: this.text, width, lines };
		return lines;
	}
}
