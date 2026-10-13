// 空行。对应 pi 的 packages/tui/src/components/spacer.ts。
import type { Component } from "../tui.ts";

export class Spacer implements Component {
	private readonly lines: number;

	constructor(lines = 1) {
		this.lines = lines;
	}

	render(): string[] {
		return Array.from({ length: this.lines }, () => "");
	}
}
