// 设置：~/.mini-pi/settings.json。用户可以在这里改默认的模型、快捷键、压缩和重试的参数……
// 对应 pi 的 packages/coding-agent/src/core/settings-manager.ts（pi 还会读取项目里的 .pi/settings.json，覆盖全局的设置）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateValue } from "../agent/validate.ts";
import type { JsonSchema } from "../ai/index.ts";
import { DEFAULT_KEYBINDINGS, type KeyAction } from "../tui/keybindings.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction.ts";
import { DEFAULT_RETRY_SETTINGS, type RetrySettings } from "./retry.ts";

export interface Settings {
	/** 默认的模型，比如 "deepseek/deepseek-chat"。命令行的 --model 和环境变量 MINI_PI_MODEL 优先 */
	defaultModel?: string;
	/** 执行危险的命令之前先问用户 */
	confirmDangerous: boolean;
	compaction: CompactionSettings;
	retry: RetrySettings;
	/** 自定义快捷键，比如 { "input.submit": ["ctrl+s"] } */
	keybindings: Partial<Record<KeyAction, string[]>>;
}

export const DEFAULT_SETTINGS: Settings = {
	confirmDangerous: true,
	compaction: DEFAULT_COMPACTION_SETTINGS,
	retry: DEFAULT_RETRY_SETTINGS,
	keybindings: {},
};

/** 设置文件的格式。用里程碑 08 写的校验函数检查，写错了能告诉用户错在哪里 */
const SETTINGS_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		defaultModel: { type: "string" },
		confirmDangerous: { type: "boolean" },
		compaction: {
			type: "object",
			additionalProperties: false,
			properties: {
				enabled: { type: "boolean" },
				reserveTokens: { type: "integer" },
				keepRecentTokens: { type: "integer" },
			},
		},
		retry: {
			type: "object",
			additionalProperties: false,
			properties: {
				enabled: { type: "boolean" },
				maxRetries: { type: "integer" },
				baseDelayMs: { type: "integer" },
			},
		},
		keybindings: {
			type: "object",
			additionalProperties: false,
			// 每个动作都可以设置成一组按键
			properties: Object.fromEntries(
				Object.keys(DEFAULT_KEYBINDINGS).map((action) => [action, { type: "array", items: { type: "string" } }]),
			),
		},
	},
};

export function getSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

/**
 * 读取设置。没有设置文件就全部用默认值。
 * 文件有问题（不是合法的 JSON、写错了名字或者类型）时，整个文件都不用，并且返回错误信息，让用户知道错在哪里。
 * 只用一部分设置会让人很困惑："为什么我的设置有的生效、有的不生效？"
 */
export function loadSettings(agentDir: string): { settings: Settings; errors: string[] } {
	const path = getSettingsPath(agentDir);
	if (!existsSync(path)) return { settings: DEFAULT_SETTINGS, errors: [] };

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return {
			settings: DEFAULT_SETTINGS,
			errors: [`设置文件不是合法的 JSON，已忽略：${path}（${error instanceof Error ? error.message : String(error)}）`],
		};
	}
	const problems = validateValue(SETTINGS_SCHEMA, value, "settings");
	if (problems.length > 0) {
		return { settings: DEFAULT_SETTINGS, errors: [`设置文件有错误，已忽略：${path}`, ...problems] };
	}
	const file = value as Partial<Settings>;
	return {
		settings: {
			...DEFAULT_SETTINGS,
			...file,
			// 嵌套的设置要单独合并：只写了 { "retry": { "maxRetries": 5 } } 时，其他的重试参数保持默认
			compaction: { ...DEFAULT_SETTINGS.compaction, ...file.compaction },
			retry: { ...DEFAULT_SETTINGS.retry, ...file.retry },
			keybindings: { ...file.keybindings },
		},
		errors: [],
	};
}
