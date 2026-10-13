import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getApiKey, getModel, resolveModel } from "../src/ai/index.ts";

const savedEnv = { ...process.env };
afterEach(() => {
	process.env = { ...savedEnv };
});

test("服务商/模型：合成完整的 Model", () => {
	const model = resolveModel("deepseek/deepseek-chat");
	assert.equal(model.provider, "deepseek");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://api.deepseek.com");
	assert.ok(model.cost.input > 0, "内置模型带有价格");
});

test("没有列出的模型名也可以用，使用服务商的默认参数", () => {
	const model = resolveModel("qwen/qwen-some-new-model");
	assert.equal(model.id, "qwen-some-new-model");
	assert.equal(model.provider, "qwen");
	assert.equal(model.contextWindow, 128_000);
	assert.equal(model.cost.input, 0);
});

test("只写模型名：在内置模型里查找", () => {
	const model = resolveModel("claude-sonnet-5-5");
	assert.equal(model.provider, "anthropic");
	assert.equal(model.api, "anthropic-messages");
});

test("模型名里可以有 /，只按第一个 / 切分", () => {
	const model = resolveModel("openrouter/openai/gpt-4o-mini");
	assert.equal(model.provider, "openrouter");
	assert.equal(model.id, "openai/gpt-4o-mini");
});

test("不认识的写法给出有帮助的错误信息", () => {
	assert.throws(() => resolveModel("no-such-model"), /服务商\/模型名/);
	assert.throws(() => getModel("no-such-provider", "x"), /不认识的服务商/);
});

test("API key：先读环境变量，本地服务使用占位 key", () => {
	process.env.DEEPSEEK_API_KEY = "sk-test";
	assert.equal(getApiKey("deepseek"), "sk-test");
	delete process.env.OPENAI_API_KEY;
	assert.equal(getApiKey("openai"), undefined);
	assert.equal(getApiKey("ollama"), "ollama");
	assert.equal(getApiKey("fake"), "fake");
});

test("custom 服务商：从 LLM_* 环境变量读取", () => {
	process.env.LLM_BASE_URL = "http://localhost:4000/v1";
	process.env.LLM_API_KEY = "fake";
	const model = resolveModel("custom/my-model");
	assert.equal(model.baseUrl, "http://localhost:4000/v1");
	assert.equal(model.id, "my-model");
	assert.equal(getApiKey("custom"), "fake");
});
