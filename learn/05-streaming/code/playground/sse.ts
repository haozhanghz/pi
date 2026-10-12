// SSE（Server-Sent Events）解析器：把服务器发来的字节流，变成一个个事件。
// 被 chat-stream.ts 导入使用。到了里程碑 06，它会搬到 src/ai/sse.ts。

/** 一个 SSE 事件 */
export interface SseEvent {
	/** event: 字段（OpenAI 不用它，Anthropic 会用） */
	event?: string;
	/** data: 字段的内容（多行 data 会用 \n 连接） */
	data: string;
}

/**
 * 第一步：字节流 → 文字流。
 * 用同一个 TextDecoder 并传入 stream: true，被切开的多字节字符（比如汉字）会被正确拼接。
 */
async function* decodeText(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	for await (const chunk of bytes) {
		const text = decoder.decode(chunk, { stream: true });
		if (text.length > 0) yield text;
	}
	const rest = decoder.decode(); // 冲刷解码器里残留的字节
	if (rest.length > 0) yield rest;
}

/**
 * 第二步：文字流 → 一行一行。
 * 网络数据可能在任意位置被切开，所以要用 buffer 攒着，遇到换行符才输出一整行。
 * 同时兼容 \n 和 \r\n 两种换行。
 */
async function* splitLines(texts: AsyncIterable<string>): AsyncGenerator<string> {
	let buffer = "";
	for await (const text of texts) {
		buffer += text;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			let line = buffer.slice(0, newline);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			yield line;
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}

/**
 * 第三步：一行一行 → 事件。
 * SSE 的规则：
 *   - "字段名: 值" 一行一个字段，常见的字段是 data 和 event；
 *   - 以冒号开头的行是注释（服务器常用它做心跳），忽略；
 *   - 空行表示"一个事件结束了"。
 */
export async function* parseSSE(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
	let event: string | undefined;
	let dataLines: string[] = [];

	for await (const line of splitLines(decodeText(bytes))) {
		if (line === "") {
			if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
			event = undefined;
			dataLines = [];
			continue;
		}
		if (line.startsWith(":")) continue;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1); // 冒号后面的一个空格不算内容

		if (field === "data") dataLines.push(value);
		else if (field === "event") event = value;
		// 其他字段（id、retry）我们用不到，忽略
	}

	// 流结束时，最后一个事件可能没有以空行结尾
	if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
}
