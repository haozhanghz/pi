import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "../src/ai/index.ts";
import { AssistantMessageView } from "../src/modes/interactive/components/assistant-message.ts";
import { ConfirmDialog } from "../src/modes/interactive/components/confirm-dialog.ts";
import { formatTokens, shortenPath } from "../src/modes/interactive/components/footer.ts";
import { sanitizeOutput, ToolExecutionView } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageView } from "../src/modes/interactive/components/user-message.ts";
import { stripAnsi } from "../src/tui/ansi.ts";
import { formatKeyId } from "../src/tui/keybindings.ts";
import { visibleWidth } from "../src/tui/width.ts";

const plain = (lines: string[]) => lines.map(stripAnsi);
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...fields,
	};
}

test("命令输出的清理：去掉颜色和控制字符，进度条只保留最后的样子", () => {
	assert.equal(sanitizeOutput("\x1b[32mok\x1b[0m\tdone"), "ok   done");
	assert.equal(sanitizeOutput("下载 10%\r下载 50%\r下载 100%\nwindows\r\n换行"), "下载 100%\nwindows\n换行");
});

test("bash：运行中显示最后几行，结束后去掉'运行中'", () => {
	const view = new ToolExecutionView("bash", { command: "npm test" });
	view.setPartialResult(text(["1", "2", "3", "4", "5", "6", "7"].join("\n")));
	assert.deepEqual(plain(view.render(40)), [
		"",
		" $ npm test 运行中……",
		" │ ……（前面还有 2 行）",
		" │ 3",
		" │ 4",
		" │ 5",
		" │ 6",
		" │ 7",
	]);
	view.setResult(text("全部通过"), false);
	assert.deepEqual(plain(view.render(40)), ["", " $ npm test", " │ 全部通过"]);
});

test("出错的工具：结果显示成红色", () => {
	const view = new ToolExecutionView("read", { path: "missing.txt" });
	view.setResult(text("文件不存在"), true);
	const lines = view.render(40);
	assert.deepEqual(plain(lines), ["", " read missing.txt", " │ 文件不存在"]);
	assert.ok(lines[2].includes("\x1b[31m"));
});

test("edit 显示带颜色的 diff，write 显示写了几行", () => {
	const edit = new ToolExecutionView("edit", { path: "a.ts" });
	edit.setResult({ ...text("已修改"), details: { diff: " 1 const a = 1;\n-2 old\n+2 new" } }, false);
	const lines = edit.render(40);
	assert.deepEqual(plain(lines).slice(1), [" edit a.ts", " │  1 const a = 1;", " │ -2 old", " │ +2 new"]);
	assert.ok(lines[3].includes("\x1b[31m-2 old") && lines[4].includes("\x1b[32m+2 new"));

	const write = new ToolExecutionView("write", { path: "b.txt", content: "一\n二\n三" });
	write.setResult(text("已写入"), false);
	assert.deepEqual(plain(write.render(40)).slice(1), [" write b.txt", " │ 已写入 3 行"]);
});

test("很长的输出行被截断，不会超出宽度", () => {
	const view = new ToolExecutionView("bash", { command: "cat 很长很长的文件名.txt" });
	view.setResult(text("很长".repeat(50)), false);
	for (const line of view.render(20)) assert.ok(visibleWidth(line) <= 20, line);
});

test("助手消息：思考、文字、出错的说明", () => {
	const view = new AssistantMessageView(
		assistant({
			content: [
				{ type: "thinking", thinking: "想一想" },
				{ type: "text", text: "**好的**" },
			],
			stopReason: "error",
			errorMessage: "网络断了",
		}),
	);
	assert.deepEqual(plain(view.render(40)), ["", " 想一想", "", " 好的", "", " 出错了：网络断了"]);
});

test("用户消息：折行之后和文字对齐", () => {
	assert.deepEqual(plain(new UserMessageView("一二三四五六七八").render(11)), ["", " > 一二三四", "   五六七八"]);
});

test("确认对话框：y 允许，n 和 Esc 拒绝，其他键没有反应", () => {
	const answers: boolean[] = [];
	const dialog = new ConfirmDialog("允许吗？", "rm -rf build", (allowed) => answers.push(allowed));
	assert.deepEqual(plain(dialog.render(30)).slice(1, -1), [" 允许吗？", " rm -rf build", " y 允许    n/Esc 拒绝"]);
	dialog.handleInput("x");
	dialog.handleInput("y");
	dialog.handleInput("n");
	dialog.handleInput("\x1b");
	assert.deepEqual(answers, [true, false, false]);
});

test("状态栏的小工具：token 数、路径、按键名", () => {
	assert.deepEqual([formatTokens(999), formatTokens(1234), formatTokens(12_345), formatTokens(2_500_000)], ["999", "1.2k", "12k", "2.5M"]);
	assert.equal(shortenPath("/home/me/project", "/home/me"), "~/project");
	assert.equal(shortenPath("/srv/app", "/home/me"), "/srv/app");
	assert.deepEqual(["ctrl+c", "escape", "y", "alt+enter"].map(formatKeyId), ["Ctrl+C", "Esc", "y", "Alt+Enter"]);
});
