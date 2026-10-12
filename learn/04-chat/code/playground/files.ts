// 用 fs/promises 异步读写文件。运行：node playground/files.ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = join(process.cwd(), "tmp-files-demo");
const file = join(dir, "note.txt");

await mkdir(dir, { recursive: true }); // recursive：父目录不存在就一起创建，已存在也不报错
await writeFile(file, "第一行\n第二行\n第三行\n", "utf-8");
console.log("写入了：", file);

const content = await readFile(file, "utf-8");
const lines = content.split("\n").filter((line) => line.length > 0);
console.log(`读回来 ${lines.length} 行：`, lines);

// 读一个不存在的文件会抛出异常，error.code 是 "ENOENT"（Error NO ENTry，没有这个文件）
try {
	await readFile(join(dir, "不存在.txt"), "utf-8");
} catch (error) {
	const code = error instanceof Error && "code" in error ? error.code : "?";
	console.log("读取不存在的文件，错误码：", code);
}

await rm(dir, { recursive: true, force: true }); // 清理
console.log("已清理临时目录");
