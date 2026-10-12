// 列出所有内置的服务商和模型，并检查哪些已经配置了 API key。
// 运行：node playground/models.ts
import { getApiKey, PROVIDERS } from "../src/ai/index.ts";

for (const provider of PROVIDERS) {
	const key = getApiKey(provider.id);
	const status = key ? "已配置" : `未配置（需要环境变量 ${provider.apiKeyEnv}）`;
	console.log(`${provider.id.padEnd(20)} ${provider.name}  [${provider.api}]  ${status}`);
	for (const model of provider.models) {
		const cost = model.cost ? `  输入 $${model.cost.input}/M，输出 $${model.cost.output}/M` : "";
		console.log(`    ${provider.id}/${model.id}${cost}`);
	}
	if (provider.models.length === 0) console.log(`    （没有内置模型，用 ${provider.id}/模型名 指定任意模型）`);
}
