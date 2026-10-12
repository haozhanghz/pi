// 测试用的迷你服务器：按顺序返回预先准备好的响应，并记录收到的请求。
// 同时支持两种流式格式：
//   - chunks：OpenAI 风格，每个 chunk 一行 data:，最后是 data: [DONE]
//   - events：Anthropic 风格，每个事件有 event: 和 data: 两行
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeResponse {
	/** HTTP 状态码，默认 200 */
	status?: number;
	/** 非 200 时返回的响应体 */
	body?: string;
	/** OpenAI 风格：200 时依次以 SSE 发送的 chunk（会被 JSON.stringify） */
	chunks?: unknown[];
	/** Anthropic 风格：200 时依次发送的事件 */
	events?: { event: string; data: unknown }[];
	/** 每个 chunk/事件之间的延迟（毫秒） */
	delayMs?: number;
	/** OpenAI 风格时，是否在最后发送 data: [DONE]，默认 true */
	done?: boolean;
}

export interface RecordedRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: any;
}

export interface FakeServer {
	/** 形如 http://127.0.0.1:12345 */
	url: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

export async function startFakeServer(responses: FakeResponse[]): Promise<FakeServer> {
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
		const pause = () => (response.delayMs ? new Promise((resolve) => setTimeout(resolve, response.delayMs)) : undefined);
		for (const chunk of response.chunks ?? []) {
			if (closed) return;
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			await pause();
		}
		for (const event of response.events ?? []) {
			if (closed) return;
			res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
			await pause();
		}
		if (response.chunks && response.done !== false) res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// ----- OpenAI 风格的 chunk -----

export function textChunk(text: string): unknown {
	return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

export function reasoningChunk(text: string): unknown {
	return { choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

export function finishChunk(reason: string): unknown {
	return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

export function usageChunk(prompt: number, completion: number, cached = 0): unknown {
	return {
		choices: [],
		usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } },
	};
}

// ----- Anthropic 风格的事件 -----

export function messageStart(usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }) {
	return {
		event: "message_start",
		data: {
			type: "message_start",
			message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "test", usage },
		},
	};
}

export function blockStart(index: number, contentBlock: Record<string, unknown>) {
	return { event: "content_block_start", data: { type: "content_block_start", index, content_block: contentBlock } };
}

export function blockDelta(index: number, delta: Record<string, unknown>) {
	return { event: "content_block_delta", data: { type: "content_block_delta", index, delta } };
}

export function blockStop(index: number) {
	return { event: "content_block_stop", data: { type: "content_block_stop", index } };
}

export function messageDelta(stopReason: string, outputTokens: number) {
	return {
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
	};
}

export function messageStop() {
	return { event: "message_stop", data: { type: "message_stop" } };
}
