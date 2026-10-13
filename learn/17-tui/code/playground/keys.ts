// 按下任意键，看看终端送来了什么、我们把它解析成了哪个键。按 Ctrl+C 退出。
// 运行：node playground/keys.ts
import { bold, cyan, dim, isPaste, keyId, ProcessTerminal, parseKey, pasteContent, visibleWidth } from "../src/tui/index.ts";

const terminal = new ProcessTerminal();

/** 把控制字符显示成能看懂的样子，比如 \x1b[A */
function escape(sequence: string): string {
	return JSON.stringify(sequence)
		.slice(1, -1)
		.replace(/\\u00([0-9a-f]{2})/g, "\\x$1");
}

/** 按显示宽度补齐（用 padEnd 的话，汉字会对不齐：它按字符数算，而一个汉字占 2 列） */
function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

terminal.write(`${bold("按下任意键试试")}（方向键、Ctrl+字母、Alt+字母、粘贴一段文字……）。按 Ctrl+C 退出。\r\n\r\n`);
terminal.start(
	(key) => {
		if (isPaste(key)) {
			const content = pasteContent(key);
			terminal.write(`${cyan(pad("粘贴", 12))} ${content.length} 个字符：${escape(content.slice(0, 40))}${content.length > 40 ? "…" : ""}\r\n`);
			return;
		}
		const id = keyId(parseKey(key));
		terminal.write(`${cyan(pad(id, 12))} ${dim(`收到：${escape(key)}`)}\r\n`);
		if (id === "ctrl+c") {
			terminal.stop();
			process.exit(0);
		}
	},
	() => terminal.write(dim(`（窗口大小变成了 ${terminal.columns} × ${terminal.rows}）\r\n`)),
);
