// 解析"可能还没写完"的 JSON。
// 流式输出工具调用时，参数是一小段一小段到达的。比如模型要写一个文件，我们可能先收到：
//   {"path": "src/ma
// 这时 JSON.parse 会报错。但界面很想提前显示"正在写 src/ma……"。
// parsePartialJson 会补上缺少的引号和括号，尽力解析出一个半成品：{ path: "src/ma" }。

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 修复字符串里的"裸"控制字符。JSON 规定字符串里的换行必须写成 \n，
 * 但有些模型会直接输出一个真正的换行符，JSON.parse 会因此报错。
 */
function escapeRawControlCharacters(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			else if (ch === "\n") {
				result += "\\n";
				continue;
			} else if (ch === "\r") {
				result += "\\r";
				continue;
			} else if (ch === "\t") {
				result += "\\t";
				continue;
			}
		} else if (ch === '"') {
			inString = true;
		}
		result += ch;
	}
	return result;
}

/** 补上没写完的字符串和括号 */
function closeJson(text: string): string {
	const closers: string[] = []; // 还没闭合的括号，需要按相反的顺序补上
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") closers.push("}");
		else if (ch === "[") closers.push("]");
		else if (ch === "}" || ch === "]") closers.pop();
	}
	let result = text;
	if (inString) {
		if (escaped) result = result.slice(0, -1); // 末尾是半个转义符 \，去掉它
		result += '"';
	}
	// 末尾多余的逗号去掉；末尾是冒号（有键没有值）就补一个 null
	result = result.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
	return result + closers.reverse().join("");
}

/**
 * 尽力解析一段可能不完整的 JSON 对象。解析不出来（或者不是对象）就返回 {}。
 * 完整的 JSON 一定能被正确解析。
 */
export function parsePartialJson(text: string): Record<string, unknown> {
	let candidate = escapeRawControlCharacters(text.trim());
	if (candidate === "") return {};
	try {
		const value: unknown = JSON.parse(candidate);
		return isPlainObject(value) ? value : {};
	} catch {
		// 不完整，下面尝试补全
	}
	// 补全之后还不行，就从末尾去掉一个字符再试（比如末尾是写了一半的 tru、12.），最多试 32 次
	for (let attempt = 0; attempt < 32 && candidate.length > 0; attempt++) {
		try {
			const value: unknown = JSON.parse(closeJson(candidate));
			return isPlainObject(value) ? value : {};
		} catch {
			candidate = candidate.slice(0, -1);
		}
	}
	return {};
}
