// 实验：一个汉字被网络切成两半会怎样？运行：node playground/utf8-split.ts
const bytes = new TextEncoder().encode("你好"); // 把文字编码成 UTF-8 字节
console.log("「你好」的 UTF-8 编码一共", bytes.length, "个字节：", Array.from(bytes));

// 假设网络把它切成了两块：前 4 个字节、后 2 个字节（"好"字被切开了）
const part1 = bytes.slice(0, 4);
const part2 = bytes.slice(4);

// 错误做法：每块单独解码
console.log("单独解码：", new TextDecoder().decode(part1), "+", new TextDecoder().decode(part2));

// 正确做法：用同一个解码器，并且告诉它"后面还有数据"（stream: true）
const decoder = new TextDecoder();
const text = decoder.decode(part1, { stream: true }) + decoder.decode(part2, { stream: true }) + decoder.decode();
console.log("流式解码：", text);
