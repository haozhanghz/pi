// 选择列表：上下方向键移动，回车确认，Esc 取消；直接打字可以筛选。用来选模型、选会话……
// 对应 pi 的 packages/tui/src/components/select-list.ts。
import { bold, cyan, dim, inverse } from "../ansi.ts";
import { matchesAction } from "../keybindings.ts";
import { isPrintable } from "../keys.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { splitGraphemes, truncateToWidth } from "../width.ts";

export interface SelectItem {
	value: string;
	label: string;
	/** 显示在名字后面的灰色说明 */
	description?: string;
}

export interface SelectListOptions {
	/** 最多同时显示几项，更多的上下滚动。默认 8 */
	maxVisible?: number;
	/** 一开始选中哪一项（比如当前的模型） */
	selectedValue?: string;
}

export class SelectList implements Component, Focusable {
	focused = false;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;

	private readonly items: SelectItem[];
	private readonly maxVisible: number;
	private filter = "";
	/** 选中的是筛选结果里的第几项 */
	private selected = 0;
	/** 第一个显示出来的是筛选结果里的第几项 */
	private scroll = 0;

	constructor(items: SelectItem[], options: SelectListOptions = {}) {
		this.items = items;
		this.maxVisible = options.maxVisible ?? 8;
		this.selected = Math.max(0, items.findIndex((item) => item.value === options.selectedValue));
	}

	handleInput(data: string): void {
		const count = this.filtered().length;
		if (matchesAction(data, "select.up")) {
			this.selected = count === 0 ? 0 : (this.selected - 1 + count) % count; // 到顶了就转到最后一项
		} else if (matchesAction(data, "select.down")) {
			this.selected = count === 0 ? 0 : (this.selected + 1) % count;
		} else if (matchesAction(data, "select.confirm")) {
			const item = this.filtered()[this.selected];
			if (item) this.onSelect?.(item);
		} else if (matchesAction(data, "select.cancel")) {
			this.onCancel?.();
		} else if (matchesAction(data, "editor.deleteCharBackward")) {
			this.setFilter(splitGraphemes(this.filter).slice(0, -1).join(""));
		} else if (isPrintable(data)) {
			this.setFilter(this.filter + data);
		}
	}

	render(width: number): string[] {
		const items = this.filtered();
		// 让选中的那一项始终看得见
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + this.maxVisible) this.scroll = this.selected - this.maxVisible + 1;

		// 第一行是筛选框。有焦点时输出光标标记：用输入法输入中文筛选时，候选词窗口出现在这里
		const cursor = this.focused ? CURSOR_MARKER + inverse(" ") : "";
		const lines = [` ${dim("筛选：")}${this.filter}${cursor}`];
		if (items.length === 0) lines.push(dim("   没有匹配的结果"));
		items.slice(this.scroll, this.scroll + this.maxVisible).forEach((item, index) => {
			const isSelected = this.scroll + index === this.selected;
			const label = isSelected ? `${cyan("›")} ${bold(item.label)}` : `  ${item.label}`;
			lines.push(` ${label}${item.description ? dim(`  ${item.description}`) : ""}`);
		});
		if (items.length > this.maxVisible) lines.push(dim(`   （${this.selected + 1}/${items.length}，上下方向键滚动）`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private setFilter(filter: string): void {
		this.filter = filter;
		this.selected = 0;
		this.scroll = 0;
	}

	/** 筛选：名字和说明里包含输入的每一个词（不区分大小写） */
	private filtered(): SelectItem[] {
		const words = this.filter.toLowerCase().split(/\s+/).filter((word) => word !== "");
		return this.items.filter((item) => {
			const text = `${item.label} ${item.description ?? ""}`.toLowerCase();
			return words.every((word) => text.includes(word));
		});
	}
}
