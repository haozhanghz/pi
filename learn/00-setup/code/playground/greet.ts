// 练习答案：读取命令行参数。运行：node playground/greet.ts 小明
// process.argv 是一个数组：
//   [0] node 程序本身的路径
//   [1] 这个脚本的路径
//   [2] 之后才是你在命令行里输入的参数
const args = process.argv.slice(2);
const who = args[0] ?? "陌生人";

console.log(`你好，${who}！`);
console.log(`现在是 ${new Date().toLocaleString("zh-CN")}`);
console.log(`你一共传了 ${args.length} 个参数：`, args);
