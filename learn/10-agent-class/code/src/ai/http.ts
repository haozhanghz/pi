// 各个适配器共用的 HTTP 小工具。

/**
 * 把 HTTP 错误整理成一句可读的话。
 * OpenAI 风格的服务返回 { "error": { "message": "..." } }，
 * Anthropic 返回 { "type": "error", "error": { "type": "...", "message": "..." } }，
 * 两种格式都能取出 error.message。
 */
export async function describeHttpError(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	let detail = text;
	try {
		const json = JSON.parse(text) as { error?: { message?: string } };
		if (json.error?.message) detail = json.error.message;
	} catch {
		// 不是 JSON，就用原始文字
	}
	return `HTTP ${response.status}：${detail || response.statusText}`;
}
