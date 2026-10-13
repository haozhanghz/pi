// 工具共用的小函数。对应 pi 的 packages/coding-agent/src/core/tools/path-utils.ts。
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 把模型给的路径变成绝对路径：
 *   - 去掉开头的 @（模型有时会照抄用户输入里的 "@src/main.ts"）
 *   - ~ 开头的路径展开成用户主目录
 *   - 相对路径相对于 cwd（agent 的工作目录），而不是程序启动时的目录
 */
export function resolvePath(path: string, cwd: string): string {
	let normalized = path.startsWith("@") ? path.slice(1) : path;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/** 如果已经取消了，就抛出异常 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("操作被取消");
}

/** 把文件系统的错误翻译成模型容易理解的说明 */
export function describeFsError(error: unknown, path: string): string {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	switch (code) {
		case "ENOENT":
			return `文件或目录不存在：${path}`;
		case "EISDIR":
			return `${path} 是一个目录，不是文件。可以用 ls 查看目录里有什么`;
		case "ENOTDIR":
			return `${path} 不是一个目录`;
		case "EACCES":
		case "EPERM":
			return `没有权限访问 ${path}`;
		default:
			return error instanceof Error ? error.message : String(error);
	}
}
