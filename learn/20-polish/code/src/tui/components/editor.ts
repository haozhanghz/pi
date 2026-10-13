// 多行编辑器：mini-pi 的输入框。可以输入多行文字、自动折行、上下左右移动、按词移动和删除、翻看历史记录。
// 对应 pi 的 packages/tui/src/components/editor.ts（两千多行，我们实现其中最常用的部分）。
import { gray, inverse } from "../ansi.ts";
import { matchesAction } from "../keybindings.ts";
import { isPaste, isPrintable, pasteContent } from "../keys.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { graphemeWidth, splitGraphemes, truncateToWidth, visibleWidth } from "../width.ts";

/** 按"词"切分文字。中文也能切：Intl.Segmenter 带着词典，"你好世界"会切成"你好"和"世界" */
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** text 里 index 左边那个字形簇的开头 */
function previousBoundary(text: string, index: number): number {
	return index - (splitGraphemes(text.slice(0, index)).at(-1)?.length ?? 0);
}

/** text 里 index 右边那个字形簇的结尾 */
function nextBoundary(text: string, index: number): number {
	return index + (splitGraphemes(text.slice(index))[0]?.length ?? 0);
}

/** index 左边一个词的开头：先跳过空白，再跳过一个词（或者一串标点） */
function wordStartBefore(text: string, index: number): number {
	const segments = [...wordSegmenter.segment(text.slice(0, index))];
	let i = segments.length - 1;
	while (i >= 0 && segments[i].segment.trim() === "") i--;
	if (i < 0) return 0;
	if (!segments[i].isWordLike) {
		while (i > 0 && !segments[i - 1].isWordLike && segments[i - 1].segment.trim() !== "") i--;
	}
	return segments[i].index;
}

/** index 右边一个词的结尾：先跳过空白，再跳过一个词（或者一串标点） */
function wordEndAfter(text: string, index: number): number {
	const segments = [...wordSegmenter.segment(text.slice(index))];
	let i = 0;
	while (i < segments.length && segments[i].segment.trim() === "") i++;
	if (i === segments.length) return text.length;
	if (!segments[i].isWordLike) {
		while (i < segments.length - 1 && !segments[i + 1].isWordLike && segments[i + 1].segment.trim() !== "") i++;
	}
	return index + segments[i].index + segments[i].segment.length;
}

/**
 * 把一行文字按宽度折行，返回每一段的起止位置。
 * 和 wrapText 一样，优先在空格后面折行，汉字之间随时可以折行。不同的是：
 *   - 返回的是位置，因为光标要知道自己在哪一段的哪个位置；
 *   - 空格不会引起折行，可以"挂"在行尾（渲染时超出宽度的部分直接截掉），这样折行处不会多出一个只有空格的行。
 */
function wrapPositions(text: string, width: number): { start: number; end: number }[] {
	const chunks: { start: number; end: number }[] = [];
	let start = 0;
	let used = 0;
	/** 最近一个可以折行的位置，以及到那里为止的宽度 */
	let breakAt = -1;
	let usedAtBreak = 0;
	let index = 0;
	for (const grapheme of splitGraphemes(text)) {
		const cols = graphemeWidth(grapheme);
		if (grapheme !== " " && used + cols > width && index > start) {
			if (breakAt > start) {
				chunks.push({ start, end: breakAt }); // 在最近的空格后面（或者汉字后面）折行
				used -= usedAtBreak;
				start = breakAt;
			} else {
				chunks.push({ start, end: index }); // 一个词比一行还宽，只能从中间断开
				used = 0;
				start = index;
			}
			breakAt = -1;
		}
		used += cols;
		index += grapheme.length;
		if (grapheme === " " || cols === 2) {
			breakAt = index;
			usedAtBreak = used;
		}
	}
	chunks.push({ start, end: text.length });
	return chunks;
}

/** 一个"屏幕行"：逻辑行（用换行符分开的行）折行之后的一段 */
interface VisualLine {
	/** 属于第几个逻辑行 */
	line: number;
	/** 在这个逻辑行里的起止位置 */
	start: number;
	end: number;
}

export interface EditorOptions {
	/** 最多显示几行，内容更多时上下滚动。默认 10 */
	maxHeight?: number;
}

export class Editor implements Component, Focusable {
	focused = false;
	/** 按下回车时调用，参数是去掉首尾空白的内容 */
	onSubmit?: (text: string) => void;
	/** 内容每次改变时调用 */
	onChange?: (text: string) => void;

	private lines: string[] = [""];
	private cursorLine = 0;
	/** 光标在当前行里的位置（字符串下标），总是落在两个字形簇之间 */
	private cursorCol = 0;
	private readonly maxHeight: number;
	/** 上下滚动：第一个显示出来的屏幕行 */
	private scroll = 0;
	/** 上一次渲染时的排版宽度。上下移动光标时要按同样的宽度折行 */
	private layoutWidth = 80;
	/** 上下移动时想保持在哪一列（显示宽度）。经过一个短行之后，还能回到原来的列 */
	private preferredColumn: number | undefined;
	/** 提交过的内容，最新的在最前面 */
	private readonly history: string[] = [];
	/** 正在看第几条历史记录；-1 表示没有在翻看 */
	private historyIndex = -1;
	/** 开始翻看历史记录之前，输入框里的内容 */
	private draft = "";

	constructor(options: EditorOptions = {}) {
		this.maxHeight = options.maxHeight ?? 10;
	}

	getText(): string {
		return this.lines.join("\n");
	}

	setText(text: string): void {
		this.historyIndex = -1;
		this.replaceText(text, "end");
	}

	getCursor(): { line: number; col: number } {
		return { line: this.cursorLine, col: this.cursorCol };
	}

	/** 记住一条提交过的内容，之后可以用上方向键找回来 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "" || this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		if (this.history.length > 100) this.history.pop();
	}

	handleInput(data: string): void {
		const isVertical = matchesAction(data, "editor.cursorUp") || matchesAction(data, "editor.cursorDown");
		if (!isVertical) this.preferredColumn = undefined;

		if (isPaste(data)) {
			this.insertText(pasteContent(data));
		} else if (matchesAction(data, "input.newLine")) {
			this.insertText("\n");
		} else if (matchesAction(data, "input.submit")) {
			this.submit();
		} else if (matchesAction(data, "editor.cursorUp")) {
			this.moveUp();
		} else if (matchesAction(data, "editor.cursorDown")) {
			this.moveDown();
		} else if (matchesAction(data, "editor.cursorLeft")) {
			this.moveLeft();
		} else if (matchesAction(data, "editor.cursorRight")) {
			this.moveRight();
		} else if (matchesAction(data, "editor.cursorWordLeft")) {
			if (this.cursorCol === 0) this.moveLeft();
			else this.cursorCol = wordStartBefore(this.currentLine, this.cursorCol);
		} else if (matchesAction(data, "editor.cursorWordRight")) {
			if (this.cursorCol === this.currentLine.length) this.moveRight();
			else this.cursorCol = wordEndAfter(this.currentLine, this.cursorCol);
		} else if (matchesAction(data, "editor.cursorLineStart")) {
			this.cursorCol = 0;
		} else if (matchesAction(data, "editor.cursorLineEnd")) {
			this.cursorCol = this.currentLine.length;
		} else if (matchesAction(data, "editor.deleteCharBackward")) {
			this.deleteBefore(previousBoundary(this.currentLine, this.cursorCol));
		} else if (matchesAction(data, "editor.deleteCharForward")) {
			this.deleteAfter(nextBoundary(this.currentLine, this.cursorCol));
		} else if (matchesAction(data, "editor.deleteWordBackward")) {
			this.deleteBefore(wordStartBefore(this.currentLine, this.cursorCol));
		} else if (matchesAction(data, "editor.deleteToLineStart")) {
			this.deleteBefore(0);
		} else if (matchesAction(data, "editor.deleteToLineEnd")) {
			this.deleteAfter(this.currentLine.length);
		} else if (isPrintable(data)) {
			this.insertText(data);
		}
	}

	render(width: number): string[] {
		// 左边空一列；右边留一列，光标在行尾时画在那里
		const contentWidth = Math.max(1, width - 2);
		this.layoutWidth = contentWidth;
		const visual = this.layout(contentWidth);
		const row = this.cursorRow(visual);

		// 上下滚动，让光标所在的行始终看得见
		if (row < this.scroll) this.scroll = row;
		if (row >= this.scroll + this.maxHeight) this.scroll = row - this.maxHeight + 1;
		this.scroll = Math.min(this.scroll, Math.max(0, visual.length - this.maxHeight));
		const shown = visual.slice(this.scroll, this.scroll + this.maxHeight);

		const result = [this.border(width, this.scroll, "↑")];
		shown.forEach((visualLine, index) => {
			let text = this.lines[visualLine.line].slice(visualLine.start, visualLine.end);
			if (this.focused && this.scroll + index === row) {
				// 光标所在的字用反色显示；光标在行尾时，画一个反色的空格
				const col = this.cursorCol - visualLine.start;
				const at = splitGraphemes(text.slice(col))[0];
				const after = at === undefined ? "" : text.slice(col + at.length);
				text = text.slice(0, col) + CURSOR_MARKER + inverse(at ?? " ") + after;
			}
			result.push(truncateToWidth(` ${text}`, width, "")); // 挂在行尾的空格超出宽度时截掉
		});
		result.push(this.border(width, visual.length - this.scroll - shown.length, "↓"));
		return result;
	}

	private get currentLine(): string {
		return this.lines[this.cursorLine];
	}

	/** 上下两条横线。有内容被滚动隐藏时，在横线上标出还有几行 */
	private border(width: number, hidden: number, arrow: string): string {
		if (hidden === 0) return gray("─".repeat(width));
		const label = ` ${arrow} 还有 ${hidden} 行 `;
		return gray(truncateToWidth(`──${label}${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}`, width, ""));
	}

	/** 把所有逻辑行按宽度折成屏幕行 */
	private layout(width: number): VisualLine[] {
		const visual: VisualLine[] = [];
		this.lines.forEach((text, line) => {
			for (const { start, end } of wrapPositions(text, width)) visual.push({ line, start, end });
		});
		return visual;
	}

	/** 光标在第几个屏幕行 */
	private cursorRow(visual: VisualLine[]): number {
		const row = visual.findIndex((visualLine, index) => {
			if (visualLine.line !== this.cursorLine) return false;
			// 光标在折行处时，算作下一段的开头；只有一行的最后一段，光标才能停在末尾
			const isLastOfLine = index === visual.length - 1 || visual[index + 1].line !== visualLine.line;
			return (
				this.cursorCol >= visualLine.start &&
				(this.cursorCol < visualLine.end || (isLastOfLine && this.cursorCol === visualLine.end))
			);
		});
		return Math.max(0, row);
	}

	/** 光标移到另一个屏幕行，尽量保持在同一列 */
	private moveToRow(visual: VisualLine[], from: number, to: number): void {
		const source = visual[from];
		const target = visual[to];
		const column = this.preferredColumn ?? visibleWidth(this.lines[source.line].slice(source.start, this.cursorCol));
		this.preferredColumn = column;
		const line = this.lines[target.line];
		let col = target.start;
		let used = 0;
		for (const grapheme of splitGraphemes(line.slice(target.start, target.end))) {
			if (used + graphemeWidth(grapheme) > column) break;
			used += graphemeWidth(grapheme);
			col += grapheme.length;
		}
		// 光标不能停在折行处的末尾，那个位置属于下一个屏幕行
		const isLastOfLine = to === visual.length - 1 || visual[to + 1].line !== target.line;
		if (col === target.end && !isLastOfLine && col > target.start) col = previousBoundary(line, col);
		this.cursorLine = target.line;
		this.cursorCol = col;
	}

	private moveUp(): void {
		const visual = this.layout(this.layoutWidth);
		const row = this.cursorRow(visual);
		if (row > 0) {
			this.moveToRow(visual, row, row - 1);
		} else if (this.historyIndex >= 0 || this.getText() === "" || this.cursorCol === 0) {
			this.browseHistory(1); // 已经在第一行：翻看更早的历史记录
		} else {
			this.cursorCol = 0; // 先移到行首，再按一次才翻看历史记录
		}
	}

	private moveDown(): void {
		const visual = this.layout(this.layoutWidth);
		const row = this.cursorRow(visual);
		if (row < visual.length - 1) {
			this.moveToRow(visual, row, row + 1);
		} else if (this.historyIndex >= 0) {
			this.browseHistory(-1); // 已经在最后一行：翻看更新的历史记录
		} else {
			this.cursorCol = this.currentLine.length;
		}
	}

	private moveLeft(): void {
		if (this.cursorCol > 0) {
			this.cursorCol = previousBoundary(this.currentLine, this.cursorCol);
		} else if (this.cursorLine > 0) {
			this.cursorLine--;
			this.cursorCol = this.currentLine.length;
		}
	}

	private moveRight(): void {
		if (this.cursorCol < this.currentLine.length) {
			this.cursorCol = nextBoundary(this.currentLine, this.cursorCol);
		} else if (this.cursorLine < this.lines.length - 1) {
			this.cursorLine++;
			this.cursorCol = 0;
		}
	}

	/** step 为 1 看更早的一条，为 -1 看更新的一条 */
	private browseHistory(step: 1 | -1): void {
		const index = this.historyIndex + step;
		if (index < -1 || index >= this.history.length) return;
		if (this.historyIndex === -1) this.draft = this.getText();
		this.historyIndex = index;
		// 往上翻时光标放在开头，往下翻时放在末尾，这样连续按同一个方向键可以一直翻下去
		this.replaceText(index === -1 ? this.draft : this.history[index], step === 1 ? "start" : "end");
	}

	private insertText(text: string): void {
		// 统一换行符，制表符换成空格，去掉其他控制字符
		const clean = text
			.replace(/\r\n?/g, "\n")
			.replaceAll("\t", "    ")
			.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
		if (clean === "") return;
		const inserted = clean.split("\n");
		const last = inserted.length - 1;
		const after = this.currentLine.slice(this.cursorCol);
		inserted[0] = this.currentLine.slice(0, this.cursorCol) + inserted[0];
		this.cursorCol = inserted[last].length;
		inserted[last] += after;
		this.lines.splice(this.cursorLine, 1, ...inserted);
		this.cursorLine += last;
		this.changed();
	}

	/** 删除光标前面、从 start 开始的内容。光标在行首时，和上一行合并 */
	private deleteBefore(start: number): void {
		if (this.cursorCol === 0) {
			if (this.cursorLine === 0) return;
			const previous = this.lines[this.cursorLine - 1];
			this.lines.splice(this.cursorLine - 1, 2, previous + this.currentLine);
			this.cursorLine--;
			this.cursorCol = previous.length;
		} else {
			this.lines[this.cursorLine] = this.currentLine.slice(0, start) + this.currentLine.slice(this.cursorCol);
			this.cursorCol = start;
		}
		this.changed();
	}

	/** 删除光标后面、到 end 为止的内容。光标在行尾时，和下一行合并 */
	private deleteAfter(end: number): void {
		if (this.cursorCol === this.currentLine.length) {
			if (this.cursorLine === this.lines.length - 1) return;
			this.lines.splice(this.cursorLine, 2, this.currentLine + this.lines[this.cursorLine + 1]);
		} else {
			this.lines[this.cursorLine] = this.currentLine.slice(0, this.cursorCol) + this.currentLine.slice(end);
		}
		this.changed();
	}

	private submit(): void {
		// 光标前面是反斜杠：删掉它，换行。这是给分不清 Shift+Enter 和 Enter 的终端准备的办法
		if (this.currentLine[this.cursorCol - 1] === "\\") {
			this.deleteBefore(this.cursorCol - 1);
			this.insertText("\n");
			return;
		}
		const text = this.getText().trim();
		this.historyIndex = -1;
		this.replaceText("", "end");
		this.onSubmit?.(text);
	}

	/** 换掉全部内容（不影响历史记录的翻看状态） */
	private replaceText(text: string, cursorAt: "start" | "end"): void {
		this.lines = text.replace(/\r\n?/g, "\n").split("\n");
		this.cursorLine = cursorAt === "start" ? 0 : this.lines.length - 1;
		this.cursorCol = cursorAt === "start" ? 0 : this.currentLine.length;
		this.scroll = 0;
		this.onChange?.(this.getText());
	}

	/** 内容被编辑之后：退出历史记录的翻看状态，通知外面 */
	private changed(): void {
		this.historyIndex = -1;
		this.onChange?.(this.getText());
	}
}
