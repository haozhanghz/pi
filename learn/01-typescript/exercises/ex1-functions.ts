// 练习 1：函数
// 完成下面三个函数（把 throw 那一行换成你的实现），然后运行：
//   node exercises/ex1-functions.ts
// 看到"练习 1 全部通过！"就成功了。如果看到 AssertionError，读一读它说的 expected 和 actual。
import assert from "node:assert/strict";

/** 返回数组里最大的数；空数组返回 undefined */
function max(numbers: number[]): number | undefined {
	throw new Error("TODO：请实现 max");
}

/** 把秒数格式化成 "1分05秒" 这样的文字；不到一分钟就是 "5秒" */
function formatDuration(seconds: number): string {
	// 提示：Math.floor 向下取整，% 取余数，String(n).padStart(2, "0") 补零
	throw new Error("TODO：请实现 formatDuration");
}

/** 截断过长的文字：超过 maxLength 个字符时，保留前 maxLength 个并加上 "…" */
function truncate(text: string, maxLength: number): string {
	// 提示：text.slice(0, n) 取前 n 个字符
	throw new Error("TODO：请实现 truncate");
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
