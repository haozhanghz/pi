// 终端：输出文字、读取按键、知道窗口有多大。
// 界面代码只和 Terminal 接口打交道，测试时可以换成一个假的终端（下一章）。
// 对应 pi 的 packages/tui/src/terminal.ts。
import { DISABLE_BRACKETED_PASTE, ENABLE_BRACKETED_PASTE, hideCursor, showCursor } from "./ansi.ts";
import { KeyBuffer } from "./keys.ts";

export interface Terminal {
	/** 宽度（列数） */
	readonly columns: number;
	/** 高度（行数） */
	readonly rows: number;
	write(data: string): void;
	/** 开始接收按键。onKey 每次收到一个完整的按键；窗口大小改变时调用 onResize */
	start(onKey: (key: string) => void, onResize: () => void): void;
	/** 恢复终端原来的状态 */
	stop(): void;
}

/** 单独一个 ESC 之后等多久，没有后续数据就认为是按了 Esc 键 */
const ESCAPE_TIMEOUT_MS = 50;

/** 真正的终端：process.stdin 和 process.stdout */
export class ProcessTerminal implements Terminal {
	private readonly keys = new KeyBuffer();
	private flushTimer: NodeJS.Timeout | undefined;
	private onKey: (key: string) => void = () => {};
	private onResize: () => void = () => {};

	get columns(): number {
		return process.stdout.columns ?? 80;
	}

	get rows(): number {
		return process.stdout.rows ?? 24;
	}

	write(data: string): void {
		process.stdout.write(data);
	}

	start(onKey: (key: string) => void, onResize: () => void): void {
		this.onKey = onKey;
		this.onResize = onResize;
		// 原始模式：每按一个键马上送给程序，不等回车；终端不再自己显示输入的字符；Ctrl+C 也不再终止程序
		process.stdin.setRawMode(true);
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", this.handleData);
		process.stdin.resume();
		process.stdout.on("resize", this.handleResize);
		this.write(ENABLE_BRACKETED_PASTE + hideCursor);
	}

	stop(): void {
		clearTimeout(this.flushTimer);
		process.stdin.off("data", this.handleData);
		process.stdout.off("resize", this.handleResize);
		this.write(DISABLE_BRACKETED_PASTE + showCursor);
		process.stdin.setRawMode(false);
		process.stdin.pause();
	}

	// 用箭头函数定义，作为事件监听器传出去时 this 不会丢
	private readonly handleData = (data: string) => {
		clearTimeout(this.flushTimer);
		for (const key of this.keys.push(data)) this.onKey(key);
		// 有不完整的数据（比如单独一个 ESC）：等一小会儿，没有后续就当作完整的按键
		if (this.keys.pending) {
			this.flushTimer = setTimeout(() => {
				for (const key of this.keys.flush()) this.onKey(key);
			}, ESCAPE_TIMEOUT_MS);
		}
	};

	private readonly handleResize = () => this.onResize();
}
