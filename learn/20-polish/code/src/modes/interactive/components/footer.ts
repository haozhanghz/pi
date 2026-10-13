// 最下面的状态栏：工作目录、模型、用掉的 token、费用、上下文用了多少。
// 对应 pi 的 packages/coding-agent/src/modes/interactive/components/footer.ts。
import { homedir } from "node:os";
import type { AgentSession } from "../../../core/agent-session.ts";
import { type Component, dim, truncateToWidth } from "../../../tui/index.ts";

/** 12345 → "12k"，1234 → "1.2k" */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 家目录换成 ~，路径短一点 */
export function shortenPath(path: string, home = homedir()): string {
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export class Footer implements Component {
	private readonly session: AgentSession;
	private readonly cwd: string;
	private text = "";

	constructor(session: AgentSession, cwd: string) {
		this.session = session;
		this.cwd = cwd;
		this.update();
	}

	/** 重新计算要显示的内容。统计要遍历整个会话，所以只在消息完成时调用，而不是每次渲染都算一遍 */
	update(): void {
		const stats = this.session.getStats();
		const { model } = this.session.agent.state;
		const percent = Math.round((this.session.getContextTokens() / model.contextWindow) * 100);
		this.text = [
			shortenPath(this.cwd),
			model.id,
			`↑${formatTokens(stats.inputTokens)} ↓${formatTokens(stats.outputTokens)}`,
			`$${stats.cost.toFixed(3)}`,
			`上下文 ${percent}%`,
		].join(" · ");
	}

	render(width: number): string[] {
		return [truncateToWidth(dim(` ${this.text}`), width)];
	}
}
