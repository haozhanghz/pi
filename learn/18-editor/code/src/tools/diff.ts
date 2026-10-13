// 逐行比较两段文字，生成给人看的 diff（界面上显示"改了哪些行"）。
// pi 用的是 diff 这个库；我们自己写一个简单的版本：先去掉开头和结尾相同的行，再对中间的部分求最长公共子序列。

export interface DiffLine {
	type: "same" | "added" | "removed";
	text: string;
	/** 在旧内容里的行号（same 和 removed 有） */
	oldLine?: number;
	/** 在新内容里的行号（same 和 added 有） */
	newLine?: number;
}

/** 中间不同的部分太大时（行数相乘超过这个数），不再求最长公共子序列，直接算作"全部删除、全部新增" */
const MAX_LCS_CELLS = 4_000_000;

/** 比较两段文字，逐行列出相同、删除、新增的行 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
	const a = oldText.split("\n");
	const b = newText.split("\n");

	// ① 开头和结尾相同的行：一次修改通常只改了中间的一小段
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}

	// ② 中间的部分：求最长公共子序列（LCS），找出哪些行没变
	const middle = diffMiddle(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));

	// ③ 拼起来，编上行号
	const result: DiffLine[] = [];
	let i = 0; // 下一个旧行
	let j = 0; // 下一个新行
	const push = (type: DiffLine["type"]) => {
		if (type === "same") {
			result.push({ type, text: a[i], oldLine: i + 1, newLine: j + 1 });
			i++;
			j++;
		} else if (type === "removed") {
			result.push({ type, text: a[i], oldLine: i + 1 });
			i++;
		} else {
			result.push({ type, text: b[j], newLine: j + 1 });
			j++;
		}
	};
	for (let k = 0; k < prefix; k++) push("same");
	for (const type of middle) push(type);
	for (let k = 0; k < suffix; k++) push("same");
	return result;
}

/** 用动态规划求两组行的最长公共子序列，返回每一步是相同、删除还是新增 */
function diffMiddle(a: string[], b: string[]): DiffLine["type"][] {
	const n = a.length;
	const m = b.length;
	if (n * m > MAX_LCS_CELLS) {
		return [...a.map(() => "removed" as const), ...b.map(() => "added" as const)];
	}

	// lcs[i * (m + 1) + j] = a 从第 i 行开始、b 从第 j 行开始，最长公共子序列有多少行
	const lcs = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * (m + 1) + j] =
				a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
		}
	}

	// 从头走一遍：两行相同就是"没变"；否则往 LCS 更长的方向走
	const result: DiffLine["type"][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			result.push("same");
			i++;
			j++;
		} else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
			result.push("removed");
			i++;
		} else {
			result.push("added");
			j++;
		}
	}
	for (; i < n; i++) result.push("removed");
	for (; j < m; j++) result.push("added");
	return result;
}

/**
 * 把 diff 格式化成文字，只显示改动的行和它们前后各 contextLines 行，其余的用 ... 代替：
 *
 *    1 import { a } from "./a";
 *   -2 const x = 1;
 *   +2 const x = 2;
 *    3 console.log(x);
 *      ...
 *
 * 同时返回第一个改动在新内容里的行号（界面可以跳到那里）。
 */
export function formatDiff(lines: DiffLine[], contextLines = 3): { diff: string; firstChangedLine?: number } {
	const maxLine = lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0);
	const width = String(maxLine).length; // 行号的宽度：最大的行号有几位数
	const changed = lines.map((line) => line.type !== "same");
	// 一行没变的行，如果离某个改动不超过 contextLines 行，就显示出来
	const visible = lines.map((_, index) => {
		const from = Math.max(0, index - contextLines);
		const to = Math.min(lines.length - 1, index + contextLines);
		for (let k = from; k <= to; k++) if (changed[k]) return true;
		return false;
	});

	const output: string[] = [];
	let firstChangedLine: number | undefined;
	let nextNewLine = 1; // 删除的行在新内容里对应的位置
	let skipping = false;
	for (const [index, line] of lines.entries()) {
		if (line.type !== "same" && firstChangedLine === undefined) {
			firstChangedLine = line.newLine ?? nextNewLine;
		}
		if (line.newLine !== undefined) nextNewLine = line.newLine + 1;

		if (!visible[index]) {
			if (!skipping) output.push(` ${"".padStart(width)} ...`);
			skipping = true;
			continue;
		}
		skipping = false;
		if (line.type === "added") output.push(`+${String(line.newLine).padStart(width)} ${line.text}`);
		else if (line.type === "removed") output.push(`-${String(line.oldLine).padStart(width)} ${line.text}`);
		else output.push(` ${String(line.oldLine).padStart(width)} ${line.text}`);
	}
	return { diff: output.join("\n"), firstChangedLine };
}
