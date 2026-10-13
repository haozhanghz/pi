// Markdown 渲染：把模型回答里的 Markdown 变成带颜色、排好版的终端文字。
// 对应 pi 的 packages/tui/src/components/markdown.ts。pi 用 marked 库解析 Markdown，我们自己写一个够用的小解析器：
// 标题、段落、粗体、斜体、删除线、行内代码、代码块、列表（可以嵌套）、引用、表格、链接、分隔线。
import { blue, bold, cyan, gray, green, italic, strikethrough, underline, yellow } from "../ansi.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapText } from "../width.ts";

/** 各种元素的样式。想换颜色，改这里就行 */
const STYLE = {
	heading: (text: string) => bold(cyan(text)),
	code: yellow,
	codeBlock: green,
	codeFence: gray,
	quote: gray,
	link: (text: string) => underline(blue(text)),
	linkUrl: gray,
	bullet: cyan,
	border: gray,
};

// ---------- 第一步：把文字切成"块" ----------

type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "code"; language: string; lines: string[] }
	| { type: "quote"; blocks: Block[] }
	| { type: "list"; items: { marker: string; blocks: Block[] }[] }
	| { type: "table"; rows: string[][] }
	| { type: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 第 i 行是不是表格的开头：这一行有竖线，下一行是 |---|---| 这样的分隔行 */
function isTableStart(lines: string[], i: number): boolean {
	const next = lines[i + 1] ?? "";
	return lines[i].includes("|") && next.includes("|") && TABLE_SEPARATOR.test(next);
}

/** 第 i 行是不是另一种块的开头（会打断段落） */
function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		RULE.test(line) ||
		QUOTE.test(line) ||
		LIST_ITEM.test(line) ||
		isTableStart(lines, i)
	);
}

function leadingSpaces(line: string): number {
	return line.length - line.trimStart().length;
}

/** 表格的一行：| a | b | 切成 ["a", "b"] */
function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function parseBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1];
			const code: string[] = [];
			i++;
			// 一直到结束标记为止。模型还在输出、结束标记还没来的时候，就到最后一行
			while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
			if (i === lines.length) {
				// 没有结束标记，说明模型还在输出。末尾的空行、只来了一半的结束标记（比如 "``"）先不显示，
				// 否则等结束标记来了，代码块会突然少一行，画面跳动
				const isPartialFence = (text: string) => [...text.trim()].every((c) => c === marker[0]);
				while (code.length > 0 && isPartialFence(code[code.length - 1])) code.pop();
			}
			i++;
			blocks.push({ type: "code", language: fence[2], lines: code });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
			i++;
			continue;
		}

		if (RULE.test(line)) {
			blocks.push({ type: "rule" });
			i++;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
			blocks.push({ type: "quote", blocks: parseBlocks(quoted) }); // 引用里面还可以有任何块
			continue;
		}

		if (LIST_ITEM.test(line)) {
			i = parseList(lines, i, blocks);
			continue;
		}

		if (isTableStart(lines, i)) {
			const rows = [splitRow(line)];
			i += 2; // 跳过表头和分隔行
			while (i < lines.length && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
			blocks.push({ type: "table", rows });
			continue;
		}

		// 段落：一直到空行，或者另一种块的开头。段落里的换行保留下来
		const paragraph = [line.trim()];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines, i)) paragraph.push(lines[i++].trim());
		blocks.push({ type: "paragraph", text: paragraph.join("\n") });
	}
	return blocks;
}

/** 解析从 start 开始的一个列表，放进 blocks，返回列表后面那一行的位置 */
function parseList(lines: string[], start: number, blocks: Block[]): number {
	const indent = leadingSpaces(lines[start]);
	const items: { marker: string; blocks: Block[] }[] = [];
	let i = start;
	while (i < lines.length) {
		const item = LIST_ITEM.exec(lines[i]);
		if (!item || item[1].length !== indent) break;
		const content = [item[3]];
		const contentIndent = indent + item[2].length + 1;
		i++;
		// 这一项的后续内容：缩进更深的行（比如嵌套的列表）、紧跟着的普通文字
		while (i < lines.length) {
			const line = lines[i];
			if (line.trim() === "") {
				// 空行：后面第一个非空行缩进更深的话，还属于这一项
				let j = i;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j === lines.length || leadingSpaces(lines[j]) <= indent) break;
				content.push("");
			} else if (leadingSpaces(line) > indent) {
				content.push(line.slice(Math.min(leadingSpaces(line), contentIndent)));
			} else if (!startsBlock(lines, i)) {
				content.push(line.trim());
			} else {
				break;
			}
			i++;
		}
		items.push({ marker: item[2], blocks: parseBlocks(content) }); // 每一项的内容又是若干个块
	}
	blocks.push({ type: "list", items });
	return i;
}

// ---------- 第二步：行内格式 ----------

interface InlineRule {
	pattern: RegExp;
	render: (match: RegExpExecArray) => string;
}

const INLINE_RULES: InlineRule[] = [
	// 转义：\* 显示成 *
	{ pattern: /\\([\\`*_{}[\]()#+\-.!|~>])/, render: (match) => match[1] },
	// 行内代码：里面的内容原样显示，不再解析
	{ pattern: /`([^`\n]+)`/, render: (match) => STYLE.code(match[1]) },
	{ pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/, render: (match) => bold(renderInline(match[1] ?? match[2])) },
	// 斜体。下划线的版本要求前后不是字母或数字，这样 snake_case_name 不会被当成斜体
	{
		pattern: /\*(?=[^\s*])([^*]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/u,
		render: (match) => italic(renderInline(match[1] ?? match[2])),
	},
	{ pattern: /~~(?=\S)([\s\S]*?\S)~~/, render: (match) => strikethrough(renderInline(match[1])) },
	{
		pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
		render: (match) => STYLE.link(renderInline(match[1])) + (match[1] === match[2] ? "" : STYLE.linkUrl(` (${match[2]})`)),
	},
	{ pattern: /<(https?:\/\/[^>\s]+)>/, render: (match) => STYLE.link(match[1]) },
];

/**
 * 处理行内格式。每一轮找出所有规则里位置最靠前的匹配，把它前面的普通文字和它渲染的结果接上，再处理剩下的部分。
 * 粗体、斜体里面还可以有别的格式，所以它们的 render 会递归调用 renderInline。
 */
function renderInline(text: string): string {
	let result = "";
	let rest = text;
	while (rest !== "") {
		let best: { match: RegExpExecArray; rule: InlineRule } | undefined;
		for (const rule of INLINE_RULES) {
			const match = rule.pattern.exec(rest);
			if (match && (best === undefined || match.index < best.match.index)) best = { match, rule };
		}
		if (best === undefined) return result + rest;
		result += rest.slice(0, best.match.index) + best.rule.render(best.match);
		rest = rest.slice(best.match.index + best.match[0].length);
	}
	return result;
}

// ---------- 第三步：把块画成行 ----------

/** 把一串块画成行。separate 为 true 时，块和块之间空一行 */
function renderBlocks(blocks: Block[], width: number, separate: boolean): string[] {
	const lines: string[] = [];
	blocks.forEach((block, index) => {
		if (separate && index > 0) lines.push("");
		for (const line of renderBlock(block, width)) lines.push(line);
	});
	return lines;
}

function renderBlock(block: Block, width: number): string[] {
	switch (block.type) {
		case "heading": {
			// 一级标题加下划线；三级及以下保留 # 号，好和二级标题区分开
			const prefix = block.level >= 3 ? `${"#".repeat(block.level)} ` : "";
			const text = STYLE.heading(prefix + renderInline(block.text));
			return wrapText(block.level === 1 ? underline(text) : text, width);
		}
		case "paragraph":
			return wrapText(renderInline(block.text), width);
		case "code": {
			const lines = [STYLE.codeFence(`\`\`\`${block.language}`)];
			for (const line of block.lines) {
				for (const part of wrapText(line, width - 2)) lines.push(`  ${STYLE.codeBlock(part)}`);
			}
			lines.push(STYLE.codeFence("```"));
			return lines;
		}
		case "quote":
			return renderBlocks(block.blocks, width - 2, true).map((line) => STYLE.quote(`│ ${line}`));
		case "list": {
			const lines: string[] = [];
			for (const item of block.items) {
				// 有序列表保留原来的编号；无序列表统一用 -
				const prefix = `${/\d/.test(item.marker) ? item.marker : "-"} `;
				const indent = " ".repeat(visibleWidth(prefix));
				const content = renderBlocks(item.blocks, width - indent.length, false);
				if (content.length === 0) content.push("");
				content.forEach((line, index) => lines.push((index === 0 ? STYLE.bullet(prefix) : indent) + line));
			}
			return lines;
		}
		case "table":
			return renderTable(block.rows, width);
		case "rule":
			return [STYLE.border("─".repeat(Math.min(width, 80)))];
	}
}

/** 表格：每一列和最宽的单元格一样宽；整个表格太宽时，把最宽的列逐渐缩窄，单元格里的文字自动折行 */
function renderTable(rows: string[][], width: number): string[] {
	const columns = Math.max(...rows.map((row) => row.length));
	const cells = rows.map((row) => Array.from({ length: columns }, (_, j) => renderInline(row[j] ?? "")));
	const widths = Array.from({ length: columns }, (_, j) => Math.max(1, ...cells.map((row) => visibleWidth(row[j]))));
	// 每一列左右各有一个空格和一条竖线："│ a │ b │"
	const tableWidth = () => widths.reduce((sum, w) => sum + w + 3, 1);
	while (tableWidth() > width && Math.max(...widths) > 1) widths[widths.indexOf(Math.max(...widths))]--;

	const border = (left: string, middle: string, right: string) =>
		STYLE.border(left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right);
	const lines = [border("┌", "┬", "┐")];
	cells.forEach((row, rowIndex) => {
		const wrapped = row.map((cell, j) => wrapText(cell, widths[j]));
		const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
		for (let k = 0; k < height; k++) {
			const parts = wrapped.map((cellLines, j) => {
				const text = cellLines[k] ?? "";
				const padded = text + " ".repeat(Math.max(0, widths[j] - visibleWidth(text)));
				return rowIndex === 0 ? bold(padded) : padded; // 表头用粗体
			});
			lines.push(STYLE.border("│ ") + parts.join(STYLE.border(" │ ")) + STYLE.border(" │"));
		}
		if (rowIndex === 0) lines.push(border("├", "┼", "┤"));
	});
	lines.push(border("└", "┴", "┘"));
	return lines;
}

/** 把 Markdown 文字渲染成不超过 width 列的若干行 */
export function renderMarkdown(text: string, width: number): string[] {
	const blocks = parseBlocks(text.replace(/\r\n?/g, "\n").replaceAll("\t", "   ").split("\n"));
	// 最后保险一下：窗口非常窄的时候，列表的缩进、代码块的缩进可能让某些行超出宽度
	return renderBlocks(blocks, width, true).map((line) => truncateToWidth(line, width));
}

/** Markdown 组件：和 Text 一样有留白和缓存 */
export class Markdown implements Component {
	private text: string;
	private readonly paddingX: number;
	private cache: { text: string; width: number; lines: string[] } | undefined;

	constructor(text = "", paddingX = 1) {
		this.text = text;
		this.paddingX = paddingX;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache && this.cache.text === this.text && this.cache.width === width) return this.cache.lines;
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const margin = " ".repeat(paddingX);
		const lines = renderMarkdown(this.text, width - paddingX * 2).map((line) => margin + line);
		this.cache = { text: this.text, width, lines };
		return lines;
	}
}
