// 在原地反复重画几行：这是差分渲染的种子（完整的版本见 src/tui/tui.ts）。
// 运行：node playground/progress.ts
import {
	clearLine,
	cursorUp,
	cyan,
	dim,
	green,
	hideCursor,
	SYNC_END,
	SYNC_START,
	showCursor,
	truncateToWidth,
	visibleWidth,
} from "../src/tui/index.ts";

const tasks = [
	{ name: "下载 node_modules", progress: 0, speed: 3 },
	{ name: "编译 TypeScript", progress: 0, speed: 5 },
	{ name: "运行测试 \u{1F9EA}", progress: 0, speed: 2 }, // \u{1F9EA} 是一个试管 emoji，占 2 列
];

/** 把文字补齐到 width 列（按显示宽度，而不是字符数） */
function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function render(): string[] {
	const width = process.stdout.columns ?? 80;
	return tasks.map((task) => {
		const filled = Math.round(task.progress / 5);
		const bar = green("█".repeat(filled)) + dim("░".repeat(20 - filled));
		const line = `${padToWidth(task.name, 18)} ${bar} ${String(task.progress).padStart(3)}%`;
		return truncateToWidth(line, width); // 窗口太窄时截断，否则一行会被终端折成两行，位置就乱了
	});
}

let previousLines = 0;
function draw(): void {
	const lines = render();
	// 光标回到上次画的第一行，逐行清除并重画。整个过程包在同步输出里，避免闪烁
	let output = SYNC_START + cursorUp(previousLines);
	for (const line of lines) output += `\r${clearLine}${line}\n`;
	output += SYNC_END;
	process.stdout.write(output);
	previousLines = lines.length;
}

process.stdout.write(`${cyan("同时进行三个任务：")}\n${hideCursor}`);
const timer = setInterval(() => {
	for (const task of tasks) task.progress = Math.min(100, task.progress + Math.ceil(Math.random() * task.speed));
	draw();
	if (tasks.every((task) => task.progress === 100)) {
		clearInterval(timer);
		process.stdout.write(`${showCursor}${green("全部完成！")}\n`);
	}
}, 50);

// 按 Ctrl+C 时，记得把光标显示回来
process.on("SIGINT", () => {
	process.stdout.write(`${showCursor}\n`);
	process.exit(130);
});
