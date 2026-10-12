// token 用量和费用的小工具。
import type { Model, Usage } from "./types.ts";

/** 一个全为 0 的用量 */
export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 按模型的价格（每百万 token 多少美元）计算费用，直接写进 usage.cost */
export function calculateCost(model: Model, usage: Usage): void {
	usage.cost.input = (usage.input * model.cost.input) / 1_000_000;
	usage.cost.output = (usage.output * model.cost.output) / 1_000_000;
	usage.cost.cacheRead = (usage.cacheRead * model.cost.cacheRead) / 1_000_000;
	usage.cost.cacheWrite = (usage.cacheWrite * model.cost.cacheWrite) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
