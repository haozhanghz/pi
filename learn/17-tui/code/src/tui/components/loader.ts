// 加载动画：一个转圈的小符号加一段说明文字，比如"⠋ 思考中……"。
// 对应 pi 的 packages/tui/src/components/loader.ts。
import { cyan, dim } from "../ansi.ts";
import type { Component, TUI } from "../tui.ts";
import { truncateToWidth } from "../width.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export class Loader implements Component {
	private readonly tui: TUI;
	private message: string;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(tui: TUI, message: string) {
		this.tui = tui;
		this.message = message;
	}

	/** 开始转圈：每隔一会儿换一帧，并请求重画 */
	start(): void {
		this.stop();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			this.tui.requestRender();
		}, INTERVAL_MS);
	}

	/** 停止转圈。用完一定要调用，否则定时器会让程序一直不退出 */
	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return [truncateToWidth(` ${cyan(FRAMES[this.frame])} ${dim(this.message)}`, width)];
	}
}
