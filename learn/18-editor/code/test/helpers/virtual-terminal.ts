// 测试用的假终端：一个迷你的终端模拟器。
// 它像真正的终端一样执行 TUI 输出的控制序列（移动光标、清除一行、换行、滚动……），把结果记在一个字符网格里。
// 测试就可以检查"屏幕上现在显示的是什么"，而不是去比对一长串难懂的转义序列。
// 对应 pi 的 packages/tui/test/virtual-terminal.ts（pi 用的是 xterm.js 的无界面版本）。
// 只实现了 TUI 用到的那些控制序列；文字样式（颜色、粗体）直接忽略。
import { KeyBuffer } from "../../src/tui/keys.ts";
import type { Terminal } from "../../src/tui/terminal.ts";
import { graphemeWidth, splitGraphemes } from "../../src/tui/width.ts";

export class VirtualTerminal implements Terminal {
	columns: number;
	rows: number;
	/** 每一次 write 的原始内容 */
	readonly writes: string[] = [];
	cursorVisible = true;
	started = false;

	/** 所有行：前面的是滚出屏幕的历史记录，最后 rows 行是屏幕。每一格是一个字形簇，宽字符的第二格是空字符串 */
	private buffer: string[][];
	/** 光标在屏幕上的位置（y 是屏幕上的第几行，不算历史记录） */
	private x = 0;
	private y = 0;
	/** 刚在最后一列写了字：再写下一个字时才换行（真实终端都是这样） */
	private pendingWrap = false;
	private readonly keys = new KeyBuffer();
	private onKey: (key: string) => void = () => {};
	private onResize: () => void = () => {};

	constructor(columns = 40, rows = 10) {
		this.columns = columns;
		this.rows = rows;
		this.buffer = Array.from({ length: rows }, () => this.blankRow());
	}

	start(onKey: (key: string) => void, onResize: () => void): void {
		this.started = true;
		this.onKey = onKey;
		this.onResize = onResize;
	}

	stop(): void {
		this.started = false;
	}

	/** 模拟用户按键。一次可以送好几个键，比如 send("abc") 或 send("\x1b[D") */
	send(data: string): void {
		for (const key of [...this.keys.push(data), ...this.keys.flush()]) this.onKey(key);
	}

	/** 模拟改变窗口大小 */
	resize(columns: number, rows: number): void {
		// 简化：真实的终端可能会把长行重新折行，这里只是把每一行截断或补齐
		this.buffer = this.buffer.map((row) => [...row.slice(0, columns), ...Array(Math.max(0, columns - row.length)).fill(" ")]);
		this.columns = columns;
		// 窗口变矮：光标不在最下面的话去掉下面的空行，否则最上面的行滚进历史记录
		for (; this.rows > rows; this.rows--) {
			if (this.y < this.rows - 1) this.buffer.pop();
			else this.y--;
		}
		for (; this.rows < rows; this.rows++) this.buffer.push(this.blankRow());
		this.x = Math.min(this.x, columns - 1);
		this.onResize();
	}

	/** 屏幕上的每一行（去掉行尾的空格） */
	getScreen(): string[] {
		return this.buffer.slice(-this.rows).map((row) => row.join("").trimEnd());
	}

	/** 滚出屏幕、进入历史记录的行 */
	getScrollback(): string[] {
		return this.buffer.slice(0, -this.rows).map((row) => row.join("").trimEnd());
	}

	/** 历史记录加上屏幕，去掉末尾的空行。相当于用户往回滚动能看到的全部内容 */
	getAllLines(): string[] {
		const lines = [...this.getScrollback(), ...this.getScreen()];
		while (lines.length > 0 && lines.at(-1) === "") lines.pop();
		return lines;
	}

	/** 光标在屏幕上的位置 */
	getCursor(): { x: number; y: number } {
		return { x: this.x, y: this.y };
	}

	write(data: string): void {
		this.writes.push(data);
		let i = 0;
		while (i < data.length) {
			const char = data[i];
			if (char === "\x1b") {
				i = this.escape(data, i);
			} else if (char === "\r") {
				this.x = 0;
				this.pendingWrap = false;
				i++;
			} else if (char === "\n") {
				this.lineFeed(); // 只换行，不回到行首（回到行首是 \r 的事）
				i++;
			} else if (char < " ") {
				i++; // 其他控制字符：忽略
			} else {
				// 一段普通文字：一直到下一个控制字符为止，切成字形簇逐个写
				let end = i;
				while (end < data.length && data[end] >= " ") end++;
				for (const grapheme of splitGraphemes(data.slice(i, end))) this.print(grapheme);
				i = end;
			}
		}
	}

	private blankRow(): string[] {
		return Array(this.columns).fill(" ");
	}

	private screenRow(y: number): string[] {
		return this.buffer[this.buffer.length - this.rows + y];
	}

	private print(grapheme: string): void {
		const width = graphemeWidth(grapheme);
		if (width === 0) return;
		if (this.pendingWrap || this.x + width > this.columns) {
			this.x = 0; // 自动换行：上一个字写在了最后一列，或者宽字符在这一行放不下了
			this.lineFeed();
		}
		const row = this.screenRow(this.y);
		row[this.x] = grapheme;
		if (width === 2) row[this.x + 1] = "";
		this.x += width;
		if (this.x >= this.columns) {
			this.x = this.columns - 1;
			this.pendingWrap = true;
		}
	}

	private lineFeed(): void {
		this.pendingWrap = false;
		if (this.y < this.rows - 1) this.y++;
		else this.buffer.push(this.blankRow()); // 已经在最下面一行：屏幕向上滚动，最上面的一行进入历史记录
	}

	/** 处理一个以 ESC 开头的控制序列，返回它后面的位置 */
	private escape(data: string, start: number): number {
		const kind = data[start + 1];
		if (kind === "[") {
			// CSI：ESC [ 参数 结尾字母
			let end = start + 2;
			while (end < data.length && !(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)) end++;
			this.csi(data.slice(start + 2, end), data[end]);
			return end + 1;
		}
		if (kind === "]" || kind === "_") {
			// OSC、APC：一直到 BEL 或者 ESC \ 为止。忽略
			let end = start + 2;
			while (end < data.length && data[end] !== "\x07" && !(data[end] === "\x1b" && data[end + 1] === "\\")) end++;
			return data[end] === "\x07" ? end + 1 : end + 2;
		}
		return start + 2;
	}

	private csi(params: string, final: string): void {
		const isPrivate = params.startsWith("?");
		const numbers = params
			.replace("?", "")
			.split(";")
			.map((part) => (part === "" ? undefined : Number(part)));
		const n = numbers[0] ?? 1;
		switch (final) {
			case "A": // 上移
				this.y = Math.max(0, this.y - n);
				break;
			case "B": // 下移（到了屏幕最下面就停住，不会滚动）
				this.y = Math.min(this.rows - 1, this.y + n);
				break;
			case "C": // 右移
				this.x = Math.min(this.columns - 1, this.x + n);
				break;
			case "D": // 左移
				this.x = Math.max(0, this.x - n);
				break;
			case "G": // 移到第 n 列
				this.x = Math.min(this.columns - 1, n - 1);
				break;
			case "H": // 移到第 n 行第 m 列
				this.y = Math.min(this.rows - 1, (numbers[0] ?? 1) - 1);
				this.x = Math.min(this.columns - 1, (numbers[1] ?? 1) - 1);
				break;
			case "K": {
				// 清除一行：0 从光标到行尾，1 从行首到光标，2 整行
				const row = this.screenRow(this.y);
				const mode = numbers[0] ?? 0;
				const from = mode === 0 ? this.x : 0;
				const to = mode === 1 ? this.x + 1 : this.columns;
				row.fill(" ", from, to);
				break;
			}
			case "J": {
				// 清屏：0 从光标到屏幕末尾，2 整个屏幕，3 历史记录
				const mode = numbers[0] ?? 0;
				if (mode === 3) {
					this.buffer = this.buffer.slice(-this.rows);
				} else {
					const firstRow = mode === 0 ? this.y + 1 : 0;
					if (mode === 0) this.screenRow(this.y).fill(" ", this.x);
					for (let y = firstRow; y < this.rows; y++) this.screenRow(y).fill(" ");
				}
				return;
			}
			case "h":
			case "l":
				if (isPrivate && n === 25) this.cursorVisible = final === "h";
				return;
			default:
				return; // 颜色、样式（m）等：忽略
		}
		if (final !== "K") this.pendingWrap = false;
	}
}
