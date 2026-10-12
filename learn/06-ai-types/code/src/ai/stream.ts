// 统一的入口：根据 model.api 选择对应的适配器。
// 上层代码（agent、界面）只调用这里的 stream / complete，不直接接触任何服务商。
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { streamOpenAI } from "./providers/openai.ts";
import type { AssistantMessage, Context, Model, StreamOptions } from "./types.ts";

/** 发起一次流式请求，返回事件流。从不抛出异常：错误会变成 error 事件。 */
export function stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream {
	switch (model.api) {
		case "openai-completions":
			return streamOpenAI(model, context, options);
		default: {
			const unknownApi: never = model.api;
			throw new Error(`不支持的接口协议：${unknownApi}`);
		}
	}
}

/** 发起请求，等待完整的回复（不关心中间过程时用它） */
export function complete(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}
