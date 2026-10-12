// 猜猜输出顺序。运行：node playground/event-loop.ts
console.log("1. 开始");

setTimeout(() => {
	console.log("4. 定时器到了（0 毫秒）");
}, 0);

Promise.resolve().then(() => {
	console.log("3. Promise 回调");
});

console.log("2. 结束");
