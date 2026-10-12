// 在 shell 里执行命令：启动进程、实时读取输出、超时和取消时终止整个进程树。
// 对应 pi 的 packages/coding-agent/src/core/tools/bash.ts（createLocalShellOperations）
// 和 src/utils/shell.ts、src/utils/child-process.ts。
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:os";

export interface RunCommandOptions {
	cwd: string;
	signal?: AbortSignal;
	/** 超时时间（毫秒），不传表示不超时 */
	timeoutMs?: number;
	/** 每收到一块输出（stdout 或 stderr）就调用一次 */
	onData: (data: Buffer) => void;
}

export interface RunCommandResult {
	/** 退出码。被信号终止时，按照 shell 的惯例是 128 + 信号编号 */
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

/** 优先用 bash；没有的话退而求其次用 sh */
function getShell(): string {
	return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}

/**
 * 终止一个进程和它启动的所有子进程。
 * 因为启动时用了 detached: true，命令运行在自己的"进程组"里，组号就是它的 pid。
 * 给负的 pid 发信号，意思是发给整个进程组。
 */
export function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL"); // 进程组不存在了，至少试着终止它自己
		} catch {
			// 进程已经结束了
		}
	}
}

/**
 * 等待进程结束。
 *
 * 通常等 "close" 事件就行：进程退出、并且输出管道都关闭了。
 * 但如果命令启动了一个后台进程（比如 `node server.js &`），后台进程会一直拿着输出管道，
 * "close" 要等它结束才会触发，工具就卡住了。所以 shell 退出（"exit" 事件）之后，
 * 如果 100 毫秒内没有新的输出，就不再等了。
 */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		let settled = false;

		const finish = (info: { code: number | null; signal: NodeJS.Signals | null }) => {
			if (settled) return;
			settled = true;
			clearTimeout(graceTimer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(info);
		};
		const armGraceTimer = () => {
			clearTimeout(graceTimer);
			graceTimer = setTimeout(() => {
				if (exitInfo) finish(exitInfo);
			}, 100);
		};

		child.once("close", (code, signal) => finish(exitInfo ?? { code, signal }));
		child.once("exit", (code, signal) => {
			exitInfo = { code, signal };
			armGraceTimer();
		});
		// shell 退出后还有输出：说明数据还在路上，再多等一会儿，免得丢掉最后的输出
		const onData = () => {
			if (exitInfo) armGraceTimer();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(graceTimer);
			reject(error);
		});
	});
}

/** 在 shell 里执行一条命令，stdout 和 stderr 合在一起，通过 onData 实时送出 */
export async function runCommand(command: string, options: RunCommandOptions): Promise<RunCommandResult> {
	const { cwd, signal, timeoutMs, onData } = options;
	if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };
	try {
		await access(cwd);
	} catch {
		throw new Error(`工作目录不存在：${cwd}`);
	}

	const child = spawn(getShell(), ["-c", command], {
		cwd,
		detached: true, // 运行在自己的进程组里，方便终止整个进程树
		stdio: ["ignore", "pipe", "pipe"], // 不给标准输入：等待输入的命令会立刻读到"输入结束"，而不是永远卡住
	});

	let timedOut = false;
	const kill = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	const timer =
		timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					kill();
				}, timeoutMs)
			: undefined;
	signal?.addEventListener("abort", kill, { once: true });
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	try {
		const { code, signal: exitSignal } = await waitForExit(child);
		// 被信号终止的进程没有退出码。按照 shell 的惯例用 128 + 信号编号，免得被误认为成功（0）
		const exitCode = code ?? (exitSignal ? 128 + (constants.signals[exitSignal] ?? 0) : null);
		return { exitCode, timedOut, aborted: signal?.aborted ?? false };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
	}
}
