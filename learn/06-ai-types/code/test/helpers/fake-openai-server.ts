// 测试用的迷你 OpenAI 兼容服务器：按顺序返回预先准备好的响应，并记录收到的请求。
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeResponse {
	/** HTTP 状态码，默认 200 */
	status?: number;
	/** 非 200 时返回的响应体 */
	body?: string;
	/** 200 时依次以 SSE 发送的 chunk（会被 JSON.stringify） */
	chunks?: unknown[];
	/** 每个 chunk 之间的延迟（毫秒） */
	delayMs?: number;
	/** 是否在最后发送 data: [DONE]，默认 true */
	done?: boolean;
}

export interface RecordedRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: any;
}

export interface FakeServer {
	/** 形如 http://127.0.0.1:12345/v1，可以直接作为 model.baseUrl */
	baseUrl: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

export async function startFakeOpenAIServer(responses: FakeResponse[]): Promise<FakeServer> {
	const requests: RecordedRequest[] = [];
	let index = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const text = Buffer.concat(chunks).toString("utf-8");
		requests.push({ path: req.url ?? "", headers: req.headers, body: text ? JSON.parse(text) : undefined });

		const response = responses[index++] ?? { status: 500, body: '{"error":{"message":"没有准备更多响应"}}' };
		const status = response.status ?? 200;
		if (status !== 200) {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(response.body ?? "");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		for (const chunk of response.chunks ?? []) {
			if (closed) return;
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
		}
		if (response.done !== false) res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** 生成一个只带文字增量的 chunk */
export function textChunk(text: string): unknown {
	return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

/** 生成一个带思考增量的 chunk */
export function reasoningChunk(text: string): unknown {
	return { choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

/** 生成一个带停止原因的 chunk */
export function finishChunk(reason: string): unknown {
	return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

/** 生成一个只带用量的 chunk（choices 为空） */
export function usageChunk(prompt: number, completion: number, cached = 0): unknown {
	return {
		choices: [],
		usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } },
	};
}
