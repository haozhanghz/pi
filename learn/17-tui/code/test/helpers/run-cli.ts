// 端到端测试用：像用户一样在命令行里运行 mini-pi（node src/cli.ts），拿到输出和退出码
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export function runCli(
	args: string[],
	options: { cwd: string; env?: Record<string, string>; input?: string },
): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			cwd: options.cwd,
			// 一个"干净"的环境：不受你电脑上的 API key、MINI_PI_MODEL 等变量影响
			env: { PATH: process.env.PATH ?? "", HOME: options.cwd, ...options.env },
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
			reject(new Error(`mini-pi 运行超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, 15_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.stdin.end(options.input ?? "");
	});
}
