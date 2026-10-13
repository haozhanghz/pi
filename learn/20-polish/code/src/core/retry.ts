// 自动重试：哪些错误值得重试、等多久。
// 对应 pi 的 packages/ai/src/utils/retry.ts（isRetryableAssistantError、retryDelayMs）。
import type { AssistantMessage } from "../ai/index.ts";

export interface RetrySettings {
	enabled: boolean;
	/** 最多重试几次（不算第一次请求） */
	maxRetries: number;
	/** 第一次重试前等多少毫秒。之后每次翻倍：2 秒、4 秒、8 秒…… */
	baseDelayMs: number;
}

/** 和 pi 的默认值一样 */
export const DEFAULT_RETRY_SETTINGS: RetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

/**
 * 临时性的错误：等一会儿再试很可能就好了。
 * 服务器太忙、请求太频繁、服务器内部出错、网络断了、超时……
 */
const RETRYABLE_PATTERN = new RegExp(
	[
		"HTTP (429|5\\d\\d)",
		"overloaded",
		"rate.?limit",
		"too many requests",
		"server.?error",
		"service.?unavailable",
		"fetch failed",
		"network",
		"socket hang up",
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"timed? ?out",
		"连接可能中断了",
	].join("|"),
	"i",
);

/** 额度用完、欠费这类错误，重试多少次都没用。服务商有时也用 429 表示它们，所以要先排除 */
const NOT_RETRYABLE_PATTERN = /insufficient_quota|quota exceeded|billing|余额不足/i;

/** 上下文太长：请求的 token 数超过了模型的上限。各家服务商的说法不一样 */
const CONTEXT_OVERFLOW_PATTERN =
	/context_length_exceeded|maximum context length|context length|prompt is too long|too many tokens|上下文过长/i;

export function isRetryableError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (NOT_RETRYABLE_PATTERN.test(message.errorMessage)) return false;
	return RETRYABLE_PATTERN.test(message.errorMessage);
}

export function isContextOverflow(message: AssistantMessage): boolean {
	return message.stopReason === "error" && CONTEXT_OVERFLOW_PATTERN.test(message.errorMessage ?? "");
}

/** 第 attempt 次重试之前等多久：指数退避，每次翻倍 */
export function retryDelayMs(settings: RetrySettings, attempt: number): number {
	return settings.baseDelayMs * 2 ** (attempt - 1);
}

/** 等待 ms 毫秒。signal 被取消时提前结束，返回 false */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
