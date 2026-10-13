// 迷你 TUI 框架：组件、容器，以及不闪烁的差分渲染。
// 对应 pi 的 packages/tui/src/tui.ts（Component、Container、TuiBase）和 tui-main-screen.ts（差分渲染）。
import {
	clearLine,
	clearScreen,
	clearScrollback,
	cursorDown,
	cursorToColumn,
	cursorUp,
	RESET,
	SYNC_END,
	SYNC_START,
} from "./ansi.ts";
import type { Terminal } from "./terminal.ts";
import { visibleWidth } from "./width.ts";

/**
 * 组件：界面上的一块东西。
 * render(width) 把自己画成若干行文字。每一行的显示宽度都不能超过 width，否则终端会自动折行，整个界面就乱了。
 */
export interface Component {
	render(width: number): string[];
	/** 获得焦点时，按键会交给它（见 TUI.setFocus） */
	handleInput?(data: string): void;
}

/** 能获得焦点的组件。焦点变化时 TUI 会设置 focused，组件据此决定画不画光标 */
export interface Focusable {
	focused: boolean;
}

function isFocusable(component: Component | undefined): component is Component & Focusable {
	return component !== undefined && "focused" in component;
}

/**
 * 光标标记：一个 APC 控制序列，不占位置，终端也会忽略它。
 * 获得焦点的输入框在光标的位置输出这个标记；TUI 找到它、把它删掉，再把终端真正的光标移到那里。
 * 为什么要移动真正的光标？输入法的候选词窗口跟着它走。光标不在输入的位置，候选词窗口就会出现在别处。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x1b\\";

/** 容器：把子组件从上到下排列起来 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) this.children.splice(index, 1);
	}

	clear(): void {
		this.children = [];
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(width)) lines.push(line);
		}
		return lines;
	}
}

/** 输入监听器：比焦点组件先收到每一个按键。返回 true 表示"已经处理了"，按键就不再往下传 */
export type InputListener = (data: string) => boolean;

/** 光标标记的位置：第几行、第几列（都从 0 开始） */
interface CursorPosition {
	row: number;
	col: number;
}

/** 两次渲染之间至少间隔多少毫秒（每秒最多约 60 次） */
const MIN_RENDER_INTERVAL_MS = 16;

/** 把光标向下（正数）或向上（负数）移动若干行 */
function moveRows(rows: number): string {
	return rows > 0 ? cursorDown(rows) : cursorUp(-rows);
}

/**
 * TUI：界面的根。它本身是一个容器，另外负责：
 *   - 把组件画到终端上，每次只重画变化的行（差分渲染）；
 *   - 把按键交给获得焦点的组件；
 *   - 合并频繁的重画请求。
 *
 * 界面画在终端的"主屏幕"上，而不是像 vim 那样切换到另一个屏幕。内容多了，上面的行会滚进终端的历史记录，
 * 用户可以用鼠标滚轮往回看，退出后内容也还留在终端里。代价是：滚进历史记录的行，光标再也回不去了。
 */
export class TUI extends Container {
	readonly terminal: Terminal;
	private focusedComponent: Component | undefined;
	private readonly inputListeners = new Set<InputListener>();
	private running = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderTime = 0;
	private forceFullRedraw = false;
	private fullRedrawCount = 0;

	// ----- 上一次渲染留下的状态，差分渲染要和它比较 -----
	private previousLines: string[] = [];
	private previousWidth = 0;
	private previousHeight = 0;
	private previousCursor: CursorPosition | undefined;
	/** 终端的光标现在在内容的第几行 */
	private cursorRow = 0;
	/** 光标到过的最下面一行。屏幕上显示的是到这一行为止的最后 rows 行，更上面的已经滚进了历史记录 */
	private bottomRow = 0;

	constructor(terminal: Terminal) {
		super();
		this.terminal = terminal;
	}

	/** 全部重画过几次（包括第一次渲染）。调试和测试用 */
	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	/** 把焦点交给一个组件：之后的按键都交给它处理 */
	setFocus(component: Component | undefined): void {
		if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
		this.focusedComponent = component;
		if (isFocusable(component)) component.focused = true;
		this.requestRender();
	}

	/** 添加一个输入监听器，返回取消监听的函数 */
	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	start(): void {
		// 从头开始：假设光标在一个空行的开头，界面从这里往下画
		this.previousLines = [];
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.previousCursor = undefined;
		this.cursorRow = 0;
		this.bottomRow = 0;
		this.running = true;
		this.terminal.start(this.handleKey, () => this.requestRender());
		this.requestRender();
	}

	stop(): void {
		if (!this.running) return;
		if (this.renderTimer) this.renderNow(); // 还没画出来的内容先画完
		this.running = false;
		// 把光标移到内容的下面。退出后 shell 的提示符出现在界面之后，而不是把界面盖住
		if (this.previousLines.length > 0) {
			this.terminal.write(`${moveRows(this.previousLines.length - 1 - this.cursorRow)}\r\n`);
		}
		this.terminal.stop();
	}

	/**
	 * 请求重画。不会马上画：同一时间的多次请求合并成一次，两次渲染之间至少间隔 MIN_RENDER_INTERVAL_MS。
	 * force 为 true 时清空屏幕全部重画（比如运行完一个会弄乱屏幕的外部程序之后）。
	 */
	requestRender(force = false): void {
		if (force) this.forceFullRedraw = true;
		if (!this.running || this.renderTimer) return;
		const wait = Math.max(0, this.lastRenderTime + MIN_RENDER_INTERVAL_MS - performance.now());
		this.renderTimer = setTimeout(() => this.renderNow(), wait);
	}

	/** 马上重画 */
	renderNow(): void {
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		if (!this.running) return;
		this.lastRenderTime = performance.now();
		this.doRender();
	}

	// 用箭头函数定义，作为回调传给终端时 this 不会丢
	private readonly handleKey = (data: string): void => {
		for (const listener of this.inputListeners) {
			if (listener(data)) {
				this.requestRender();
				return;
			}
		}
		this.focusedComponent?.handleInput?.(data);
		this.requestRender();
	};

	private doRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const { lines, cursor } = extractCursor(this.render(width));

		let output: string;
		if (this.previousWidth === 0) {
			output = this.fullRedraw(lines, width, false); // 第一次渲染：直接从光标所在的位置往下画
		} else if (this.forceFullRedraw || width !== this.previousWidth || height !== this.previousHeight) {
			output = this.fullRedraw(lines, width, true); // 窗口大小变了：折行全变了，清空重画
		} else {
			output = this.diffRender(lines, width, height);
		}
		// 画了东西，或者光标标记换了位置：把终端的光标移到标记处
		const cursorMoved = cursor?.row !== this.previousCursor?.row || cursor?.col !== this.previousCursor?.col;
		if (output !== "" || cursorMoved) output += this.placeCursor(cursor, height);

		if (output !== "") this.terminal.write(SYNC_START + output + SYNC_END);
		this.previousLines = lines;
		this.previousWidth = width;
		this.previousHeight = height;
		this.previousCursor = cursor;
		this.forceFullRedraw = false;
	}

	/** 全部重画。clear 为 true 时先清空屏幕和历史记录 */
	private fullRedraw(lines: string[], width: number, clear: boolean): string {
		this.fullRedrawCount++;
		let output = clear ? clearScreen + clearScrollback : "";
		output += lines.map((line, row) => this.checkWidth(line, row, width)).join("\r\n");
		this.cursorRow = Math.max(0, lines.length - 1);
		this.bottomRow = this.cursorRow;
		return output;
	}

	/** 差分渲染：找到第一个和最后一个变化的行，只重画它们之间的部分 */
	private diffRender(lines: string[], width: number, height: number): string {
		const previous = this.previousLines;
		let first = 0;
		while (first < lines.length && first < previous.length && lines[first] === previous[first]) first++;
		if (first === lines.length && first === previous.length) return ""; // 什么都没变

		// 屏幕上能看到的第一行。变化发生在它上面（已经滚进历史记录）的话，只能清空屏幕全部重画
		const firstVisibleRow = Math.max(0, this.bottomRow - height + 1);
		if (first < firstVisibleRow) return this.fullRedraw(lines, width, true);

		// 最后一个变化的行。行数没变时，它下面的行都不用动；行数变了，后面的行都要重画（或者清掉）
		const end = Math.max(lines.length, previous.length);
		let last = end - 1;
		if (lines.length === previous.length) {
			while (last > first && lines[last] === previous[last]) last--;
		}

		let output: string;
		if (first < previous.length || first === 0) {
			// 这一行已经在屏幕上了：用光标移动过去
			output = `${moveRows(first - this.cursorRow)}\r`;
		} else {
			// 新增的行在屏幕上还不存在：先到原来的最后一行，再用 \r\n 换到下一行（在屏幕底部时，终端会自动向上滚动）
			output = `${moveRows(previous.length - 1 - this.cursorRow)}\r\n`;
		}
		for (let row = first; row <= last; row++) {
			if (row > first) output += "\r\n";
			// 先清除这一行原来的内容再写。内容变少时，多出来的旧行只清除、不写
			output += clearLine + (row < lines.length ? this.checkWidth(lines[row], row, width) : "");
		}
		this.cursorRow = last;
		this.bottomRow = Math.max(this.bottomRow, last);
		return output;
	}

	/** 把终端的光标移到光标标记的位置（为了输入法）。光标是隐藏的，用户看到的是组件自己画的"假光标" */
	private placeCursor(cursor: CursorPosition | undefined, height: number): string {
		if (!cursor) return "";
		const firstVisibleRow = Math.max(0, this.bottomRow - height + 1);
		if (cursor.row < firstVisibleRow) return ""; // 标记已经滚出了屏幕，光标过不去
		const output = moveRows(cursor.row - this.cursorRow) + cursorToColumn(cursor.col);
		this.cursorRow = cursor.row;
		return output;
	}

	/** 宽度契约：任何一行都不能比终端宽。违反了就恢复终端并报错，帮你尽早发现有问题的组件 */
	private checkWidth(line: string, row: number, width: number): string {
		const lineWidth = visibleWidth(line);
		if (lineWidth > width) {
			this.stop();
			throw new Error(
				`第 ${row} 行有 ${lineWidth} 列，超过了终端的宽度 ${width} 列。` +
					"组件 render(width) 返回的每一行都不能比 width 宽，请用 truncateToWidth() 或 wrapText() 处理。",
			);
		}
		return line;
	}
}

/** 找到光标标记，记下位置并把它删掉；顺便在每一行末尾加上 RESET，防止颜色"漏"到下一行 */
function extractCursor(rendered: string[]): { lines: string[]; cursor: CursorPosition | undefined } {
	let cursor: CursorPosition | undefined;
	const lines = rendered.map((line, row) => {
		const index = line.indexOf(CURSOR_MARKER);
		if (index === -1) return line + RESET;
		cursor = { row, col: visibleWidth(line.slice(0, index)) };
		return line.replaceAll(CURSOR_MARKER, "") + RESET;
	});
	return { lines, cursor };
}
