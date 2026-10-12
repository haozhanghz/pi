// 课程检查脚本（各里程碑的 check.test.ts）共用的小工具。
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

/**
 * 要检查哪个项目：
 * - 设置了环境变量 MY_PI（例如 MY_PI=~/my-pi），就检查你自己的项目；
 * - 否则检查这个里程碑的参考答案 code/。
 */
export function projectDir(milestoneDir: string): string {
	const mine = process.env.MY_PI;
	if (mine) return resolve(mine.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
	return join(milestoneDir, "code");
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * 在 cwd 目录下运行 `node <script> ...args`，返回退出码和输出。
 * env 会和一个"干净"的环境合并：只保留 PATH 和 HOME，避免你电脑上的 LLM_* 变量干扰检查。
 * input 会被写进子进程的标准输入（模拟用户在终端里打字），写完后关闭。
 */
export function runNode(
	cwd: string,
	script: string,
	args: string[],
	env: Record<string, string>,
	options: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [script, ...args], {
			cwd,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`运行超时（${options.timeoutMs ?? 15000}ms）：node ${script}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, options.timeoutMs ?? 15000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** 一个可以交互的子进程：边运行边写输入、等待某段输出出现、发送信号。 */
export interface InteractiveProcess {
	/** 到目前为止的全部标准输出 */
	readonly stdout: string;
	readonly stderr: string;
	write(text: string): void;
	/** 关闭标准输入（相当于用户按 Ctrl+D） */
	end(): void;
	/** 发送信号，例如 "SIGINT"（相当于在管道模式下按 Ctrl+C） */
	signal(name: NodeJS.Signals): void;
	/** 等到标准输出里出现匹配 pattern 的内容（从 fromIndex 开始找） */
	waitFor(pattern: RegExp, options?: { timeoutMs?: number; fromIndex?: number }): Promise<void>;
	/** 等待进程退出，返回退出码 */
	exited: Promise<number | null>;
}

export function spawnNode(cwd: string, script: string, args: string[], env: Record<string, string>): InteractiveProcess {
	const child = spawn(process.execPath, [script, ...args], {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const waiters = new Set<() => void>();
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf-8");
		for (const check of waiters) check();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	child.stdin.on("error", () => {});
	const exited = new Promise<number | null>((resolvePromise) => child.on("close", (code) => resolvePromise(code)));

	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		write(text: string) {
			child.stdin.write(text);
		},
		end() {
			child.stdin.end();
		},
		signal(name: NodeJS.Signals) {
			child.kill(name);
		},
		waitFor(pattern: RegExp, options = {}) {
			const timeoutMs = options.timeoutMs ?? 10000;
			const fromIndex = options.fromIndex ?? 0;
			return new Promise<void>((resolvePromise, reject) => {
				const check = () => {
					if (pattern.test(stdout.slice(fromIndex))) {
						clearTimeout(timer);
						waiters.delete(check);
						resolvePromise();
					}
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`等待输出 ${pattern} 超时。\n目前的输出：\n${stdout}\n错误输出：\n${stderr}`));
				}, timeoutMs);
				waiters.add(check);
				check();
			});
		},
		exited,
	};
}
