// 解析命令行参数。对应 pi 的 packages/coding-agent/src/cli/args.ts。
import { parseArgs } from "node:util";
import { APP_NAME } from "../core/config.ts";

export interface CliArgs {
	help: boolean;
	version: boolean;
	/** 非交互模式：处理完消息就退出 */
	print: boolean;
	/** print 模式的输出格式：text 只输出最终回答，json 输出所有事件 */
	mode: "text" | "json";
	model?: string;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	/** 只启用这些工具 */
	tools?: string[];
	noTools: boolean;
	/** 继续这个目录里最近的会话 */
	continue: boolean;
	/** 从列表里选择一个会话继续 */
	resume: boolean;
	/** 打开指定的会话（文件路径，或者 id 的开头几个字符） */
	session?: string;
	/** 不保存会话 */
	noSession: boolean;
	/** 假装模型的上下文窗口只有这么大（用来试验上下文压缩） */
	contextWindow?: number;
	/** 使用简单的逐行交互模式，而不是全屏的终端界面 */
	plain: boolean;
	/** @文件 参数：文件内容会附加到第一条消息里 */
	fileArgs: string[];
	/** 要发送的消息 */
	messages: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		// parseArgs 的错误信息是英文的，比如 "Unknown option '--foo'"。补上一句提示
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n运行 ${APP_NAME} --help 查看用法。`);
	}
	const { values, positionals } = parsed;

	const contextWindow = values["context-window"] !== undefined ? Number(values["context-window"]) : undefined;
	if (contextWindow !== undefined && !(contextWindow > 0)) throw new Error("--context-window 必须是一个正数");

	const mode = values.mode ?? "text";
	if (mode !== "text" && mode !== "json") throw new Error(`--mode 只能是 text 或 json，而不是 ${mode}`);

	return {
		help: values.help ?? false,
		version: values.version ?? false,
		print: (values.print ?? false) || values.mode !== undefined,
		mode,
		model: values.model,
		systemPrompt: values["system-prompt"],
		appendSystemPrompt: values["append-system-prompt"] ?? [],
		tools: values.tools
			?.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== ""),
		noTools: values["no-tools"] ?? false,
		continue: values.continue ?? false,
		resume: values.resume ?? false,
		session: values.session,
		noSession: values["no-session"] ?? false,
		contextWindow,
		plain: values.plain ?? false,
		fileArgs: positionals.filter((arg) => arg.startsWith("@")).map((arg) => arg.slice(1)),
		messages: positionals.filter((arg) => !arg.startsWith("@")),
	};
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true, // 遇到不认识的参数就报错，而不是悄悄忽略
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			print: { type: "boolean", short: "p" },
			mode: { type: "string" },
			model: { type: "string", short: "m" },
			"system-prompt": { type: "string" },
			"append-system-prompt": { type: "string", multiple: true },
			tools: { type: "string", short: "t" },
			"no-tools": { type: "boolean" },
			continue: { type: "boolean", short: "c" },
			resume: { type: "boolean", short: "r" },
			session: { type: "string" },
			"no-session": { type: "boolean" },
			"context-window": { type: "string" },
			plain: { type: "boolean" },
		},
	});
}

export function helpText(): string {
	return `${APP_NAME}：一个能读写文件、执行命令的编程助手

用法：
  ${APP_NAME} [选项] [@文件...] [消息...]

选项：
  -m, --model <服务商/模型>        使用哪个模型，例如 deepseek/deepseek-chat（默认读取环境变量 MINI_PI_MODEL）
  -p, --print                      非交互模式：处理完消息，输出最终回答后退出
      --mode <text|json>           print 模式的输出格式：text 只输出最终回答，json 每行输出一个事件
      --system-prompt <文字|文件>  替换默认的系统提示词
      --append-system-prompt <文字|文件>
                                   在系统提示词后面追加内容（可以用多次）
  -t, --tools <工具,工具>          只启用这些工具，例如 read,ls
      --no-tools                   不启用任何工具
  -c, --continue                   继续这个目录里最近的会话
  -r, --resume                     从列表里选择一个会话继续
      --session <文件|id>          打开指定的会话
      --no-session                 不保存这次的会话
      --context-window <token 数>  假装模型的上下文窗口只有这么大（用来试验上下文压缩）
      --plain                      使用简单的逐行交互模式（终端界面显示不正常时试试它）
  -h, --help                       显示帮助
  -v, --version                    显示版本

例子：
  ${APP_NAME}                                  进入交互模式
  ${APP_NAME} -c                               接着上次的对话继续
  ${APP_NAME} -p "列出所有 TypeScript 文件"     问一个问题，输出回答后退出
  ${APP_NAME} -p @src/main.ts "解释这个文件"    把文件内容附加到消息里
  cat error.log | ${APP_NAME} -p "这是什么错误"   管道输入的内容也会附加到消息里
`;
}
