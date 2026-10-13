// 迷你 TUI 框架的演示：一个"假聊天"程序。输入一句话按回车，"助手"会先转一会儿圈，再一个字一个字地回答。
// 最下面一行显示渲染的统计数字，可以看到差分渲染每一帧只写了很少的字节。
// 运行：node playground/tui-demo.ts
//      node playground/tui-demo.ts --full    每一帧都清空屏幕全部重画，对比一下字节数和闪烁
import { parseArgs } from "node:util";
import {
	bold,
	type Component,
	Container,
	cyan,
	dim,
	green,
	Input,
	Loader,
	matchesKey,
	ProcessTerminal,
	Spacer,
	splitGraphemes,
	Text,
	TUI,
	truncateToWidth,
} from "../src/tui/index.ts";

const { values } = parseArgs({ options: { full: { type: "boolean", default: false } } });

/** 在真正的终端外面包一层，数一数每次写了多少字节。界面代码只认 Terminal 接口，所以可以这样"偷梁换柱" */
class CountingTerminal extends ProcessTerminal {
	lastBytes = 0;
	totalBytes = 0;

	override write(data: string): void {
		this.lastBytes = Buffer.byteLength(data);
		this.totalBytes += this.lastBytes;
		super.write(data);
	}
}

/** --full 模式：每次重画都清空屏幕全部重画 */
class FullRedrawTUI extends TUI {
	override requestRender(): void {
		super.requestRender(true);
	}
}

const terminal = new CountingTerminal();
const tui = values.full ? new FullRedrawTUI(terminal) : new TUI(terminal);
const messages = new Container();
const input = new Input(`${cyan(">")} `);
let frames = 0;

/** 状态栏：组件不一定要写成类，有 render 方法的对象就行。它每次渲染时读取最新的统计数字 */
const status: Component = {
	render(width) {
		frames++;
		const text = ` 第 ${frames} 帧 · 上一次写入 ${terminal.lastBytes} 字节 · 一共 ${terminal.totalBytes} 字节 · 全部重画 ${tui.fullRedraws} 次`;
		return [truncateToWidth(dim(text), width)];
	},
};

tui.addChild(new Text(`${bold("迷你 TUI 演示")}  ${dim("输入一句话按回车，Ctrl+C 退出")}`, 1, 1));
tui.addChild(messages);
tui.addChild(new Spacer(1));
tui.addChild(input);
tui.addChild(status);
tui.setFocus(input);

input.onSubmit = (value) => {
	if (value.trim() === "") return;
	input.setValue("");
	messages.addChild(new Text(`${green("你：")}${value}`));
	reply(value);
};

/** 假装在思考，然后一个字一个字地回答 */
function reply(question: string): void {
	const loader = new Loader(tui, "思考中……");
	messages.addChild(loader);
	loader.start();
	setTimeout(() => {
		loader.stop();
		messages.removeChild(loader);
		const answer = new Text("");
		messages.addChild(answer);
		const characters = splitGraphemes(
			`你刚才说的是"${question}"。这段回答会一个字一个字地出现，就像大模型的流式输出一样。` +
				"注意看最下面一行：每一帧只重画了正在变化的那几行，写入的字节数很少。" +
				"试试拖动窗口改变宽度，会触发一次全部重画。",
		);
		let shown = 0;
		const timer = setInterval(() => {
			shown++;
			answer.setText(`${cyan("助手：")}${characters.slice(0, shown).join("")}`);
			tui.requestRender();
			if (shown === characters.length) clearInterval(timer);
		}, 30);
	}, 800);
}

tui.addInputListener((data) => {
	if (!matchesKey(data, "ctrl+c")) return false;
	tui.stop();
	process.exit(0);
});

tui.start();
