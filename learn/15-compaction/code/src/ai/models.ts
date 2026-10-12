// 模型注册表：内置的服务商和模型，以及"根据名字找到模型"的函数。
// 对应 pi 的 packages/ai/src/providers/*.ts 和 packages/ai/src/models.ts。
//
// 注意：模型名和价格经常变化，这里只是例子。没有列出来的模型名也可以用（会使用服务商的默认参数），
// 价格以服务商官网为准。
import type { Api, Model } from "./types.ts";

/** 模型的描述：没写的字段使用服务商的默认值 */
export interface ModelInfo {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	/** 每百万 token 多少美元 */
	cost?: Model["cost"];
}

/** 服务商的描述 */
export interface ProviderInfo {
	id: string;
	name: string;
	api: Api;
	baseUrl: string;
	/** 从哪个环境变量读取 API key */
	apiKeyEnv?: string;
	/** 不需要 key 的服务（本地服务、假模型服务器）用这个占位 */
	defaultApiKey?: string;
	/** 没有列在 models 里的模型使用的默认参数 */
	defaults: { contextWindow: number; maxTokens: number };
	models: ModelInfo[];
}

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const PROVIDERS: ProviderInfo[] = [
	{
		id: "fake",
		name: "假模型服务器（课程提供，OpenAI 协议）",
		api: "openai-completions",
		baseUrl: "http://localhost:4000/v1",
		defaultApiKey: "fake",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [{ id: "fake-model", name: "Fake Model" }],
	},
	{
		id: "fake-anthropic",
		name: "假模型服务器（课程提供，Anthropic 协议）",
		api: "anthropic-messages",
		baseUrl: "http://localhost:4000",
		defaultApiKey: "fake",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [{ id: "fake-model", name: "Fake Model" }],
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [
			{
				id: "deepseek-chat",
				name: "DeepSeek Chat",
				cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
			},
			{
				id: "deepseek-reasoner",
				name: "DeepSeek Reasoner",
				reasoning: true,
				maxTokens: 32_768,
				cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
			},
		],
	},
	{
		// DeepSeek 也提供 Anthropic 兼容的接口，可以用来测试 Anthropic 适配器（地址以官方文档为准）
		id: "deepseek-anthropic",
		name: "DeepSeek（Anthropic 协议）",
		api: "anthropic-messages",
		baseUrl: "https://api.deepseek.com/anthropic",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [{ id: "deepseek-chat", cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } }],
	},
	{
		id: "qwen",
		name: "通义千问（阿里云百炼）",
		api: "openai-completions",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: "DASHSCOPE_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [{ id: "qwen-plus" }, { id: "qwen-max" }],
	},
	{
		id: "moonshot",
		name: "Kimi（Moonshot）",
		api: "openai-completions",
		baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [],
	},
	{
		id: "zhipu",
		name: "智谱",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKeyEnv: "ZHIPU_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [],
	},
	{
		id: "siliconflow",
		name: "硅基流动",
		api: "openai-completions",
		baseUrl: "https://api.siliconflow.cn/v1",
		apiKeyEnv: "SILICONFLOW_API_KEY",
		defaults: { contextWindow: 32_000, maxTokens: 4096 },
		models: [],
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKeyEnv: "OPENROUTER_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 8192 },
		models: [],
	},
	{
		id: "openai",
		name: "OpenAI",
		api: "openai-completions",
		baseUrl: "https://api.openai.com/v1",
		apiKeyEnv: "OPENAI_API_KEY",
		defaults: { contextWindow: 128_000, maxTokens: 16_384 },
		models: [],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		defaults: { contextWindow: 200_000, maxTokens: 64_000 },
		models: [
			{
				id: "claude-opus-5-5",
				name: "Claude Opus 5.5",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			},
			{
				id: "claude-sonnet-5-5",
				name: "Claude Sonnet 5.5",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			},
			{
				id: "claude-haiku-5-5",
				name: "Claude Haiku 5.5",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
			},
		],
	},
	{
		id: "ollama",
		name: "Ollama（本地）",
		api: "openai-completions",
		baseUrl: "http://localhost:11434/v1",
		defaultApiKey: "ollama",
		defaults: { contextWindow: 32_000, maxTokens: 4096 },
		models: [],
	},
];

export function getProvider(id: string): ProviderInfo | undefined {
	return PROVIDERS.find((provider) => provider.id === id);
}

/** 把服务商的描述和模型的描述合成一个完整的 Model */
function buildModel(provider: ProviderInfo, info: ModelInfo): Model {
	return {
		id: info.id,
		name: info.name ?? info.id,
		api: provider.api,
		provider: provider.id,
		baseUrl: provider.baseUrl,
		reasoning: info.reasoning ?? false,
		contextWindow: info.contextWindow ?? provider.defaults.contextWindow,
		maxTokens: info.maxTokens ?? provider.defaults.maxTokens,
		cost: info.cost ?? FREE,
	};
}

/**
 * 找到某个服务商的某个模型。
 * 模型名不在列表里也没关系：服务商会不断推出新模型，我们用默认参数创建一个。
 * 特殊的服务商 "custom" 从环境变量 LLM_BASE_URL（和可选的 LLM_API）读取地址，兼容前几个里程碑的配置方式。
 */
export function getModel(providerId: string, modelId?: string): Model {
	if (providerId === "custom") {
		const baseUrl = process.env.LLM_BASE_URL;
		if (!baseUrl) throw new Error("使用 custom 服务商时，需要设置环境变量 LLM_BASE_URL");
		const id = modelId ?? process.env.LLM_MODEL;
		if (!id) throw new Error("使用 custom 服务商时，需要指定模型名（或者设置环境变量 LLM_MODEL）");
		const api = (process.env.LLM_API as Api | undefined) ?? "openai-completions";
		const custom: ProviderInfo = {
			id: "custom",
			name: "自定义",
			api,
			baseUrl,
			apiKeyEnv: "LLM_API_KEY",
			defaults: { contextWindow: 128_000, maxTokens: 8192 },
			models: [],
		};
		return buildModel(custom, { id });
	}

	const provider = getProvider(providerId);
	if (!provider) {
		const known = PROVIDERS.map((p) => p.id).join("、");
		throw new Error(`不认识的服务商：${providerId}。可用的服务商有：${known}、custom`);
	}
	const id = modelId ?? provider.models[0]?.id;
	if (!id) throw new Error(`服务商 ${providerId} 没有内置模型，请指定模型名，例如 ${providerId}/模型名`);
	const info = provider.models.find((model) => model.id === id) ?? { id };
	return buildModel(provider, info);
}

/**
 * 根据一个字符串找到模型。支持三种写法：
 *   "deepseek/deepseek-chat"       服务商/模型
 *   "openrouter/openai/gpt-4o"     模型名本身也可以包含 /，只按第一个 / 切分
 *   "claude-sonnet-5-5"            只写模型名：在所有服务商的内置模型里查找
 */
export function resolveModel(spec: string): Model {
	const slash = spec.indexOf("/");
	if (slash !== -1) {
		const providerId = spec.slice(0, slash);
		if (providerId === "custom" || getProvider(providerId)) {
			return getModel(providerId, spec.slice(slash + 1));
		}
	}
	for (const provider of PROVIDERS) {
		if (provider.models.some((model) => model.id === spec)) return getModel(provider.id, spec);
	}
	throw new Error(`找不到模型：${spec}。请用"服务商/模型名"的格式，例如 deepseek/deepseek-chat`);
}

/**
 * 读取某个服务商的 API key：先看环境变量，再看占位用的默认 key。
 * 找不到时返回 undefined。
 */
export function getApiKey(providerId: string): string | undefined {
	if (providerId === "custom") return process.env.LLM_API_KEY;
	const provider = getProvider(providerId);
	if (!provider) return undefined;
	return (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined) ?? provider.defaultApiKey;
}
