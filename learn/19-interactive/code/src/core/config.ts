// 程序的基本信息和配置目录。对应 pi 的 packages/coding-agent/src/config.ts。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "mini-pi";

/** 版本号从 package.json 里读取，只需要在一个地方维护 */
export const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;

/**
 * mini-pi 自己的数据目录：全局的 AGENTS.md、会话记录（里程碑 14）、设置（里程碑 20）都放在这里。
 * 默认是 ~/.mini-pi；可以用环境变量 MINI_PI_DIR 换一个地方（测试时很有用）。
 */
export function getAgentDir(): string {
	return process.env.MINI_PI_DIR ?? join(homedir(), ".mini-pi");
}
