#!/usr/bin/env node
// mini-pi 的入口：解析命令行参数，组装好 agent，然后进入 print 模式或交互模式。
// 对应 pi 的 packages/coding-agent/src/main.ts。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool } from "./agent/index.ts";
import { resolveModel } from "./ai/index.ts";
import { type CliArgs, helpText, parseCliArgs } from "./cli/args.ts";
import { APP_NAME, getAgentDir, VERSION } from "./core/config.ts";
import { loadContextFiles } from "./core/context-files.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { runPrintMode } from "./modes/print.ts";
import { runReplMode } from "./modes/repl.ts";
import { createCodingTools, resolvePath } from "./tools/index.ts";

/** 参数的值如果是一个存在的文件，就读取文件的内容；否则就是文字本身 */
function readTextOrFile(value: string): string {
	const path = resolvePath(value, process.cwd());
	return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf-8") : value;
}

function selectTools(all: AgentTool[], names: string[]): AgentTool[] {
	const unknown = names.filter((name) => !all.some((tool) => tool.name === name));
	if (unknown.length > 0) {
		throw new Error(`不认识的工具：${unknown.join("、")}。可用的工具有：${all.map((tool) => tool.name).join("、")}`);
	}
	return all.filter((tool) => names.includes(tool.name));
}

/** 读取管道输入的全部内容（比如 cat error.log | mini-pi -p "解释一下"） */
async function readStdin(): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8").trim();
	return text === "" ? undefined : text;
}

/**
 * 组装要发送的消息：管道输入的内容、@文件的内容和第一条消息合成一条；后面的消息各自单独发送。
 * 文件用 <file> 标签包起来，模型能看清楚每个文件从哪里开始、到哪里结束。
 */
function buildMessages(args: CliArgs, stdinText: string | undefined): string[] {
	const parts: string[] = [];
	if (stdinText) parts.push(`${stdinText}\n`);
	for (const file of args.fileArgs) {
		const path = resolvePath(file, process.cwd());
		if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
		parts.push(`<file name="${path}">\n${readFileSync(path, "utf-8")}\n</file>\n`);
	}
	const [first, ...rest] = args.messages;
	if (first) parts.push(first);
	return parts.length > 0 ? [parts.join(""), ...rest] : rest;
}

async function main(argv: string[]): Promise<number> {
	const args = parseCliArgs(argv);
	if (args.help) {
		process.stdout.write(helpText());
		return 0;
	}
	if (args.version) {
		console.log(VERSION);
		return 0;
	}

	// ~/.mini-pi/.env 里可以放 API key 和默认模型。环境变量里已有的值优先
	const envFile = join(getAgentDir(), ".env");
	if (existsSync(envFile)) process.loadEnvFile(envFile);

	const cwd = process.cwd();
	const model = resolveModel(args.model ?? process.env.MINI_PI_MODEL ?? "fake/fake-model");
	const allTools = createCodingTools(cwd);
	const tools = args.noTools ? [] : args.tools ? selectTools(allTools, args.tools) : allTools;
	const contextFiles = loadContextFiles(cwd, getAgentDir());
	const systemPrompt = buildSystemPrompt({
		cwd,
		tools,
		contextFiles,
		customPrompt: args.systemPrompt !== undefined ? readTextOrFile(args.systemPrompt) : undefined,
		appendPrompt: args.appendSystemPrompt.map(readTextOrFile).join("\n\n") || undefined,
	});
	const agent = new Agent({ model, systemPrompt, tools });

	// 输入或输出被管道连接时（不是终端），自动使用 print 模式
	const print = args.print || !process.stdin.isTTY || !process.stdout.isTTY;
	const stdinText = process.stdin.isTTY ? undefined : await readStdin();
	const messages = buildMessages(args, stdinText);

	if (print) {
		if (messages.length === 0) {
			console.error(`print 模式需要一条消息，例如：${APP_NAME} -p "你好"`);
			return 1;
		}
		process.on("SIGINT", () => agent.abort());
		return runPrintMode(agent, { mode: args.mode, messages });
	}

	await runReplMode(agent, {
		banner: [
			`${APP_NAME} ${VERSION}  模型：${model.provider}/${model.id}`,
			`工作目录：${cwd}`,
			...contextFiles.map((file) => `已加载项目说明：${file.path}`),
		],
		initialMessages: messages,
	});
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	console.error(`${APP_NAME}：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
