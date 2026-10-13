// 输入框和 Markdown 的演示：在下面的输入框里写 Markdown，上面实时显示渲染的效果；按回车把它"发送"到上面。
// 运行：node playground/markdown-demo.ts              交互模式
//      node playground/markdown-demo.ts README.md    把一个 Markdown 文件渲染出来看看
import { readFileSync } from "node:fs";
import {
	bold,
	type Component,
	Container,
	dim,
	Editor,
	Markdown,
	matchesKey,
	ProcessTerminal,
	renderMarkdown,
	Spacer,
	Text,
	TUI,
} from "../src/tui/index.ts";

const file = process.argv[2];
if (file) {
	for (const line of renderMarkdown(readFileSync(file, "utf8"), process.stdout.columns ?? 80)) console.log(line);
	process.exit(0);
}

const tui = new TUI(new ProcessTerminal());
const messages = new Container();
const preview = new Markdown("");
const editor = new Editor({ maxHeight: 8 });

/** 预览区：输入框里有内容时，显示渲染的效果 */
const previewArea: Component = {
	render(width) {
		if (editor.getText().trim() === "") return [];
		return [dim(" 预览："), ...preview.render(width), ""];
	},
};

tui.addChild(new Text(bold("Markdown 预览"), 1, 1));
tui.addChild(messages);
tui.addChild(previewArea);
tui.addChild(editor);
tui.addChild(new Text(dim("回车发送 · Alt+Enter 或 Ctrl+J 换行 · ↑ 翻看历史 · Ctrl+C 退出")));
tui.setFocus(editor);

editor.onChange = (text) => preview.setText(text);
editor.onSubmit = (text) => {
	if (text === "") return;
	editor.addToHistory(text);
	messages.addChild(new Markdown(text));
	messages.addChild(new Spacer(1));
};
editor.setText("试试 **粗体**、`代码` 和列表：\n- 第一项\n- 第二项");

tui.addInputListener((data) => {
	if (!matchesKey(data, "ctrl+c")) return false;
	tui.stop();
	process.exit(0);
});

tui.start();
