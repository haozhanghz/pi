// 单行输入框：可以打字、删除、左右移动光标，内容太长时横向滚动。
// 对应 pi 的 packages/tui/src/components/input.ts。下一章的多行编辑器是它的"加强版"。
import { inverse } from "../ansi.ts";
import { isPaste, isPrintable, keyId, parseKey, pasteContent } from "../keys.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { graphemeWidth, splitGraphemes, truncateToWidth, visibleWidth } from "../width.ts";

export class Input implements Component, Focusable {
	focused = false;
	/** 按下回车时调用 */
	onSubmit?: (value: string) => void;
	/** 按下 Esc 时调用 */
	onEscape?: () => void;

	private readonly prompt: string;
	private value = "";
	/** 光标的位置：value 里的下标，总是落在两个字形簇之间 */
	private cursor = 0;
	/** 横向滚动：第一个显示出来的字形簇是第几个 */
	private scroll = 0;

	constructor(prompt = "> ") {
		this.prompt = prompt;
	}

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = value.length;
	}

	handleInput(data: string): void {
		if (isPaste(data)) {
			// 单行输入框放不下换行，换成空格
			this.insert(pasteContent(data).replace(/\r\n|\r|\n/g, " "));
			return;
		}
		switch (keyId(parseKey(data))) {
			case "enter":
				this.onSubmit?.(this.value);
				return;
			case "escape":
				this.onEscape?.();
				return;
			case "backspace": {
				const start = this.previousBoundary(); // 删除整个字形簇，而不是半个 emoji
				this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
				this.cursor = start;
				return;
			}
			case "delete":
			case "ctrl+d":
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.nextBoundary());
				return;
			case "left":
			case "ctrl+b":
				this.cursor = this.previousBoundary();
				return;
			case "right":
			case "ctrl+f":
				this.cursor = this.nextBoundary();
				return;
			case "home":
			case "ctrl+a":
				this.cursor = 0;
				return;
			case "end":
			case "ctrl+e":
				this.cursor = this.value.length;
				return;
			case "ctrl+u": // 删除光标前面的所有内容
				this.value = this.value.slice(this.cursor);
				this.cursor = 0;
				return;
			case "ctrl+k": // 删除光标后面的所有内容
				this.value = this.value.slice(0, this.cursor);
				return;
		}
		if (isPrintable(data)) this.insert(data);
	}

	render(width: number): string[] {
		const available = width - visibleWidth(this.prompt);
		if (available < 2) return [truncateToWidth(this.prompt, width)];

		const graphemes = splitGraphemes(this.value);
		const cursorIndex = splitGraphemes(this.value.slice(0, this.cursor)).length;
		// 光标在最后面时，画一个空格当作光标
		if (this.focused && cursorIndex === graphemes.length) graphemes.push(" ");

		// 调整滚动位置，让光标始终在可见范围里
		const widthBetween = (from: number, to: number) =>
			graphemes.slice(from, to).reduce((sum, grapheme) => sum + graphemeWidth(grapheme), 0);
		if (cursorIndex < this.scroll) this.scroll = cursorIndex;
		while (widthBetween(this.scroll, cursorIndex + 1) > available) this.scroll++;

		let line = this.prompt;
		let used = 0;
		for (let i = this.scroll; i < graphemes.length; i++) {
			const grapheme = graphemes[i];
			used += graphemeWidth(grapheme);
			if (used > available) break;
			// 有焦点时，在光标处输出光标标记，并用反色画一个"假光标"
			line += this.focused && i === cursorIndex ? CURSOR_MARKER + inverse(grapheme) : grapheme;
		}
		return [line];
	}

	private insert(text: string): void {
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
	}

	/** 光标左边那个字形簇的开头 */
	private previousBoundary(): number {
		const before = splitGraphemes(this.value.slice(0, this.cursor));
		return this.cursor - (before.at(-1)?.length ?? 0);
	}

	/** 光标右边那个字形簇的结尾 */
	private nextBoundary(): number {
		const after = splitGraphemes(this.value.slice(this.cursor));
		return this.cursor + (after[0]?.length ?? 0);
	}
}
