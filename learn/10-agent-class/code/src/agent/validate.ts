// 校验模型给出的工具参数。
// 模型生成的参数不一定靠谱：可能漏掉必填参数、类型写错（比如把数字写成字符串）。
// 我们按工具定义里的 JSON Schema 检查一遍：小问题自动修正，大问题报告给模型，让它重试。
// 对应 pi 的 packages/ai/src/utils/validation.ts（pi 用 TypeBox 库来做）。
import type { JsonSchema, Tool } from "../ai/index.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "数组";
	return typeof value;
}

/**
 * 自动修正常见的小问题，返回修正后的新值（不修改原值）：
 *   - 需要数字，给的是数字字符串 "10" → 10
 *   - 需要布尔值，给的是 "true" / "false" → true / false
 *   - 可选参数给了 null → 当作没给（删掉）
 */
function coerce(schema: JsonSchema, value: unknown): unknown {
	switch (schema.type) {
		case "number":
		case "integer":
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			return value;
		case "boolean":
			if (value === "true") return true;
			if (value === "false") return false;
			return value;
		case "array":
			if (Array.isArray(value) && schema.items) {
				const itemSchema = schema.items;
				return value.map((item) => coerce(itemSchema, item));
			}
			return value;
		case "object": {
			if (!isPlainObject(value)) return value;
			const result: Record<string, unknown> = {};
			const required = schema.required ?? [];
			for (const [key, item] of Object.entries(value)) {
				if (item === null && !required.includes(key)) continue;
				const propertySchema = schema.properties?.[key];
				result[key] = propertySchema ? coerce(propertySchema, item) : item;
			}
			return result;
		}
		default:
			return value;
	}
}

/** 检查 value 是否符合 schema，返回所有发现的问题（空数组表示没问题） */
export function validateValue(schema: JsonSchema, value: unknown, path: string): string[] {
	const errors: string[] = [];
	if (schema.enum && !schema.enum.some((option) => option === value)) {
		errors.push(`${path}：必须是 ${schema.enum.map((option) => JSON.stringify(option)).join("、")} 之一`);
	}
	switch (schema.type) {
		case "object": {
			if (!isPlainObject(value)) {
				errors.push(`${path}：必须是对象，实际是 ${describe(value)}`);
				break;
			}
			for (const key of schema.required ?? []) {
				if (value[key] === undefined) errors.push(`${path}.${key}：缺少必填参数`);
			}
			for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
				if (value[key] !== undefined) errors.push(...validateValue(propertySchema, value[key], `${path}.${key}`));
			}
			if (schema.additionalProperties === false) {
				for (const key of Object.keys(value)) {
					if (!schema.properties?.[key]) errors.push(`${path}.${key}：不认识的参数`);
				}
			}
			break;
		}
		case "array":
			if (!Array.isArray(value)) {
				errors.push(`${path}：必须是数组，实际是 ${describe(value)}`);
			} else if (schema.items) {
				const itemSchema = schema.items;
				value.forEach((item, index) => {
					errors.push(...validateValue(itemSchema, item, `${path}[${index}]`));
				});
			}
			break;
		case "string":
			if (typeof value !== "string") errors.push(`${path}：必须是字符串，实际是 ${describe(value)}`);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}：必须是数字，实际是 ${describe(value)}`);
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}：必须是整数，实际是 ${describe(value)}`);
			break;
		case "boolean":
			if (typeof value !== "boolean") errors.push(`${path}：必须是布尔值，实际是 ${describe(value)}`);
			break;
		case "null":
			if (value !== null) errors.push(`${path}：必须是 null`);
			break;
	}
	return errors;
}

/**
 * 校验并修正工具参数。通过时返回修正后的参数；不通过时抛出异常，异常信息会被发回给模型，
 * 所以要写得让模型看得懂：哪里错了、它实际发来的是什么。
 */
export function validateToolArguments(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
	const coerced = coerce(tool.parameters, args);
	const errors = validateValue(tool.parameters, coerced, "参数");
	if (errors.length > 0) {
		throw new Error(
			`工具 ${tool.name} 的参数不正确：\n${errors.map((error) => `  - ${error}`).join("\n")}\n\n收到的参数：\n${JSON.stringify(args, null, 2)}`,
		);
	}
	return coerced as Record<string, unknown>;
}
