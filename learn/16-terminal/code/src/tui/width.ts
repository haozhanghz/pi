// 文字在终端里占几列。
// 问题："你好".length 是 2，但它在终端里占 4 列；一个 emoji 可能由好几个码点组成，却只占 2 列；
// 颜色控制序列有十几个字符，却 1 列也不占。不算对宽度，界面就会错位。
// 对应 pi 的 packages/tui/src/utils.ts（visibleWidth、truncateToWidth、wrapTextWithAnsi）。
import { ANSI_PATTERN, RESET } from "./ansi.ts";

/** 把文字切成"用户眼中的一个字符"（字形簇）。比如 "e" 加上一个声调符号是一个字形簇，一个家庭 emoji 也是一个 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 东亚宽字符（汉字、假名、韩文、全角符号……）的码点范围，每个占 2 列 */
const WIDE_RANGES: [number, number][] = [
	[0x1100, 0x115f], // 韩文字母
	[0x2e80, 0x303e], // 中日韩部首、中文标点（。、「」等）
	[0x3041, 0x33ff], // 平假名、片假名、注音符号……
	[0x3400, 0x4dbf], // 汉字扩展 A
	[0x4e00, 0x9fff], // 常用汉字
	[0xa000, 0xa4cf], // 彝文
	[0xac00, 0xd7a3], // 韩文音节
	[0xf900, 0xfaff], // 兼容汉字
	[0xfe30, 0xfe4f], // 兼容形式
	[0xff00, 0xff60], // 全角字母和标点（，：？！等）
	[0xffe0, 0xffe6], // 全角符号（￥等）
	[0x20000, 0x3fffd], // 汉字扩展 B 及以后
];

function isWide(codePoint: number): boolean {
	return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 一个字形簇占几列 */
export function graphemeWidth(grapheme: string): number {
	const codePoint = grapheme.codePointAt(0) ?? 0;
	if (codePoint >= 0x20 && codePoint < 0x7f) return 1; // 最常见的情况：英文字母、数字、标点
	if (codePoint < 0x20 || codePoint === 0x7f) return 0; // 控制字符
	if (/\p{Emoji_Presentation}|️/u.test(grapheme)) return 2; // emoji
	if (/^\p{Mark}+$/u.test(grapheme)) return 0; // 单独的组合符号
	return isWide(codePoint) ? 2 : 1;
}

/** 一段文字在终端里占几列（控制序列不占位置） */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of segmenter.segment(text.replace(ANSI_PATTERN, ""))) width += graphemeWidth(segment);
	return width;
}

/** 文字的组成部分：控制序列（不占位置），或者一个字形簇 */
type Token = { ansi: string } | { grapheme: string; width: number };

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const addText = (part: string) => {
		for (const { segment } of segmenter.segment(part)) tokens.push({ grapheme: segment, width: graphemeWidth(segment) });
	};
	let last = 0;
	for (const match of text.matchAll(ANSI_PATTERN)) {
		addText(text.slice(last, match.index));
		tokens.push({ ansi: match[0] });
		last = match.index + match[0].length;
	}
	addText(text.slice(last));
	return tokens;
}

/** 截断到最多 maxWidth 列，超出时末尾加上省略号。控制序列都保留，最后加一个 RESET 防止样式"漏"出去 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const limit = maxWidth - visibleWidth(ellipsis);
	let result = "";
	let width = 0;
	let hasAnsi = false;
	for (const token of tokenize(text)) {
		if ("ansi" in token) {
			result += token.ansi;
			hasAnsi = true;
		} else {
			if (width + token.width > limit) break;
			result += token.grapheme;
			width += token.width;
		}
	}
	return `${result}${hasAnsi ? RESET : ""}${limit >= 0 ? ellipsis : ""}`;
}

/** 汉字、假名这类文字可以在任意两个字之间换行；英文单词不行 */
function isBreakableAnywhere(grapheme: string): boolean {
	return isWide(grapheme.codePointAt(0) ?? 0);
}

/** SGR 控制序列（颜色、粗体……）。换行时要记住哪些样式还"开着" */
function isStyle(ansi: string): boolean {
	return /^\x1b\[[0-9;]*m$/.test(ansi);
}

function isReset(ansi: string): boolean {
	return ansi === "\x1b[0m" || ansi === "\x1b[m";
}

/**
 * 按宽度自动换行，返回每一行。
 *   - 英文单词不会被拆开（除非一个单词本身就比一行还宽），在空格处换行；
 *   - 汉字可以在任意两个字之间换行；
 *   - 带颜色的文字：在行尾关闭样式，在下一行开头重新打开，每一行都是"独立"的。
 */
export function wrapText(text: string, width: number): string[] {
	const result: string[] = [];
	for (const paragraph of text.split("\n")) result.push(...wrapLine(paragraph, Math.max(1, width)));
	return result;
}

function wrapLine(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	/** 当前还"开着"的样式 */
	let active: string[] = [];

	const breakLine = () => {
		line = line.replace(/ +$/, ""); // 行尾的空格没有意义
		lines.push(active.length > 0 ? `${line}${RESET}` : line);
		line = active.join("");
		lineWidth = 0;
	};

	// 先把文字分成"单元"：一个英文单词（连同里面的控制序列）、一段空格、一个汉字
	const units: Token[][] = [];
	let word: Token[] = [];
	const endWord = () => {
		if (word.length > 0) units.push(word);
		word = [];
	};
	for (const token of tokenize(text)) {
		if ("ansi" in token) {
			word.push(token);
		} else if (token.grapheme === " ") {
			endWord();
			units.push([token]);
		} else if (isBreakableAnywhere(token.grapheme)) {
			endWord();
			units.push([token]);
		} else {
			word.push(token);
		}
	}
	endWord();

	for (const unit of units) {
		const unitWidth = unit.reduce((sum, token) => sum + ("ansi" in token ? 0 : token.width), 0);
		const isSpace = unit.length === 1 && "grapheme" in unit[0] && unit[0].grapheme === " ";
		if (lineWidth + unitWidth > width && lineWidth > 0) {
			if (isSpace) {
				breakLine(); // 在空格处换行，空格本身丢掉
				continue;
			}
			breakLine();
		}
		for (const token of unit) {
			if ("ansi" in token) {
				line += token.ansi;
				if (isReset(token.ansi)) active = [];
				else if (isStyle(token.ansi)) active.push(token.ansi);
				continue;
			}
			// 一个单词比一行还宽：只能在中间拆开
			if (lineWidth + token.width > width && lineWidth > 0) breakLine();
			line += token.grapheme;
			lineWidth += token.width;
		}
	}
	lines.push(line);
	return lines;
}
