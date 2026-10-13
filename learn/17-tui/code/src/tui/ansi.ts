// ANSI 转义序列：控制终端的"暗号"。
// 往终端输出一段以 ESC（\x1b）开头的特殊文字，终端不会把它显示出来，而是执行对应的操作：换颜色、移动光标、清除一行……
// 对应 pi 的 packages/tui/src/utils.ts 和 terminal.ts 里的相关部分。

const ESC = "\x1b";
/** CSI（Control Sequence Introducer）：大部分控制序列都以 ESC [ 开头 */
const CSI = `${ESC}[`;

// ---------- 文字样式（SGR：Select Graphic Rendition） ----------

/** 清除所有样式 */
export const RESET = `${CSI}0m`;

function style(open: number, close: number): (text: string) => string {
	return (text) => `${CSI}${open}m${text}${CSI}${close}m`;
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const italic = style(3, 23);
export const underline = style(4, 24);
/** 反色：前景色和背景色互换（常用来画一个假的光标） */
export const inverse = style(7, 27);

export const red = style(31, 39);
export const green = style(32, 39);
export const yellow = style(33, 39);
export const blue = style(34, 39);
export const magenta = style(35, 39);
export const cyan = style(36, 39);
export const gray = style(90, 39);
export const bgGray = style(100, 49);

/** 任意颜色（真彩色，需要终端支持） */
export function rgb(r: number, g: number, b: number): (text: string) => string {
	return (text) => `${CSI}38;2;${r};${g};${b}m${text}${CSI}39m`;
}

// ---------- 光标和屏幕 ----------

export const cursorUp = (n = 1) => (n > 0 ? `${CSI}${n}A` : "");
export const cursorDown = (n = 1) => (n > 0 ? `${CSI}${n}B` : "");
/** 移动到第 column 列（从 0 开始数） */
export const cursorToColumn = (column: number) => `${CSI}${column + 1}G`;
export const hideCursor = `${CSI}?25l`;
export const showCursor = `${CSI}?25h`;
/** 清除光标所在的整行 */
export const clearLine = `${CSI}2K`;
/** 清除整个屏幕，光标回到左上角 */
export const clearScreen = `${CSI}2J${CSI}H`;
/** 清除历史记录（滚出屏幕的那些行） */
export const clearScrollback = `${CSI}3J`;

/**
 * 同步输出（CSI 2026）：告诉终端"接下来的内容先别显示，等我说结束再一起显示"。
 * 一次重绘要输出很多控制序列，没有它的话，终端可能显示到一半，屏幕会闪烁。不支持的终端会忽略它。
 */
export const SYNC_START = `${CSI}?2026h`;
export const SYNC_END = `${CSI}?2026l`;

/** 括号粘贴模式：粘贴的内容会被包在 PASTE_START 和 PASTE_END 之间，程序就能区分"粘贴"和"打字" */
export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

// ---------- 识别和去掉控制序列 ----------

/**
 * 匹配一个控制序列：
 *   CSI：ESC [ 参数 结尾字母，比如 \x1b[31m、\x1b[2K
 *   OSC：ESC ] ... 以 BEL 或 ESC \ 结尾，比如终端超链接
 *   APC：ESC _ ... 以 ESC \ 结尾（TUI 用它做光标的标记）
 */
export const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g;

/** 去掉所有控制序列，只留下能看见的文字 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}
