// 练习 1：函数（参考答案）
import assert from "node:assert/strict";

/** 返回数组里最大的数；空数组返回 undefined */
function max(numbers: number[]): number | undefined {
	if (numbers.length === 0) return undefined;
	let result = numbers[0];
	for (const n of numbers) {
		if (n > result) result = n;
	}
	return result;
}

/** 把秒数格式化成 "1分05秒" 这样的文字；不到一分钟就是 "5秒" */
function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes === 0) return `${rest}秒`;
	return `${minutes}分${String(rest).padStart(2, "0")}秒`;
}

/** 截断过长的文字：超过 maxLength 个字符时，保留前 maxLength 个并加上 "…" */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}…`;
}

// ----- 检查（不要修改下面的代码） -----
assert.equal(max([3, 9, 2]), 9);
assert.equal(max([-5, -2, -9]), -2);
assert.equal(max([]), undefined);
assert.equal(formatDuration(5), "5秒");
assert.equal(formatDuration(65), "1分05秒");
assert.equal(formatDuration(600), "10分00秒");
assert.equal(truncate("hello", 10), "hello");
assert.equal(truncate("hello world", 5), "hello…");
console.log("练习 1 全部通过！");
