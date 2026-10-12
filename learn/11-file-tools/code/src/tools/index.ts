// 工具层的公开接口。对应 pi 的 packages/coding-agent/src/core/tools/index.ts。
import type { AgentTool } from "../agent/index.ts";
import { createEditTool } from "./edit.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export * from "./diff.ts";
export * from "./edit.ts";
export * from "./file-mutation-queue.ts";
export * from "./ls.ts";
export * from "./read.ts";
export * from "./truncate.ts";
export * from "./util.ts";
export * from "./write.ts";

/** coding agent 的全部工具。相对路径都相对于 cwd */
export function createCodingTools(cwd: string): AgentTool[] {
	return [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createLsTool(cwd)];
}
