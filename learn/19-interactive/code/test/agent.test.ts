import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createFauxModel, type Message, stream } from "../src/ai/index.ts";
import { Agent, type AgentEvent, type AgentTool } from "../src/agent/index.ts";

/** 执行时调用 onRun 的工具，用来在"工具执行期间"做点什么（插话、取消……） */
function hookTool(onRun: () => void): AgentTool {
	return {
		name: "work",
		description: "干活",
		parameters: { type: "object", properties: {} },
		async execute() {
			onRun();
			return { content: [{ type: "text", text: "干完了" }] };
		},
	};
}

function texts(messages: Message[]): string[] {
	return messages.map((m) => {
		if (m.role === "user") return `user:${m.content}`;
		if (m.role === "toolResult") return `toolResult:${m.toolName}`;
		const text = m.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return `assistant:${text}`;
	});
}

test("prompt 之后，state.messages 里是完整的对话", async () => {
	const faux = createFauxModel([{ text: "你好！" }]);
	const agent = new Agent({ model: faux.model });
	await agent.prompt("hi");
	assert.deepEqual(texts(agent.state.messages), ["user:hi", "assistant:你好！"]);
});

test("多次 prompt：模型能看到之前的对话", async () => {
	const faux = createFauxModel([{ text: "我记住了" }, { text: "你叫小明" }]);
	const agent = new Agent({ model: faux.model, systemPrompt: "你是助手" });
	await agent.prompt("我叫小明");
	await agent.prompt("我叫什么？");
	assert.equal(faux.requests[1].messages.length, 3);
	assert.equal(faux.requests[1].systemPrompt, "你是助手");
	assert.equal(agent.state.messages.length, 4);
});

test("subscribe 收到事件；取消订阅后不再收到", async () => {
	const faux = createFauxModel([{ text: "一" }, { text: "二" }]);
	const agent = new Agent({ model: faux.model });
	const received: AgentEvent[] = [];
	const unsubscribe = agent.subscribe((event) => void received.push(event));
	await agent.prompt("1");
	const count = received.length;
	assert.equal(received[0].type, "agent_start");
	assert.equal(received.at(-1)?.type, "agent_end");
	unsubscribe();
	await agent.prompt("2");
	assert.equal(received.length, count);
});

test("运行时 isStreaming 为 true，结束后为 false；waitForIdle 等到运行结束", async () => {
	const faux = createFauxModel([{ text: "慢慢说", delayMs: 10 }]);
	const agent = new Agent({ model: faux.model });
	const states: boolean[] = [];
	agent.subscribe(() => void states.push(agent.state.isStreaming));
	const running = agent.prompt("hi");
	assert.equal(agent.state.isStreaming, true);
	await agent.waitForIdle();
	assert.equal(agent.state.isStreaming, false);
	assert.ok(states.every((s) => s));
	await running;
});

test("运行时再次 prompt 会报错", async () => {
	const faux = createFauxModel([{ text: "慢慢说", delayMs: 10 }]);
	const agent = new Agent({ model: faux.model });
	const running = agent.prompt("1");
	await assert.rejects(agent.prompt("2"), /正在运行/);
	await running;
});

test("流式接收时，state.streamingMessage 是还没完成的回复", async () => {
	const faux = createFauxModel([{ text: "一段比较长的回答" }]);
	const agent = new Agent({ model: faux.model });
	const partials: string[] = [];
	agent.subscribe((event) => {
		if (event.type === "message_update") {
			const message = agent.state.streamingMessage as AssistantMessage;
			partials.push(message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
		}
	});
	await agent.prompt("hi");
	assert.ok(partials.length > 1);
	assert.ok(partials[0].length < partials.at(-1)!.length, "内容越来越长");
	assert.equal(agent.state.streamingMessage, undefined, "结束后清空");
});

test("工具执行期间，pendingToolCalls 里有这个调用的 id", async () => {
	let pendingDuringRun: string[] = [];
	const faux = createFauxModel([{ toolCalls: [{ id: "call_1", name: "work", arguments: {} }] }, { text: "好了" }]);
	const agent = new Agent({ model: faux.model });
	agent.state.tools = [hookTool(() => (pendingDuringRun = [...agent.state.pendingToolCalls]))];
	await agent.prompt("干活");
	assert.deepEqual(pendingDuringRun, ["call_1"]);
	assert.equal(agent.state.pendingToolCalls.size, 0);
});

test("abort：取消当前运行，最后一条消息是 aborted，errorMessage 被设置", async () => {
	const faux = createFauxModel([{ text: "一段很长很长的回答", delayMs: 20 }]);
	const agent = new Agent({ model: faux.model });
	agent.subscribe((event) => {
		if (event.type === "message_update") agent.abort();
	});
	await agent.prompt("hi");
	const last = agent.state.messages.at(-1);
	assert.equal(last?.role === "assistant" && last.stopReason, "aborted");
	assert.ok(agent.state.errorMessage);
	assert.equal(agent.state.isStreaming, false);
});

test("取消之后可以继续对话", async () => {
	const faux = createFauxModel([{ text: "一段很长很长的回答", delayMs: 20 }, { text: "好的" }]);
	const agent = new Agent({ model: faux.model });
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_update") agent.abort();
	});
	await agent.prompt("1");
	unsubscribe();
	await agent.prompt("2");
	assert.equal(agent.state.errorMessage, undefined, "新的运行开始时清除旧的错误");
	assert.deepEqual(texts(agent.state.messages).slice(-2), ["user:2", "assistant:好的"]);
});

test("steer：运行中插话，模型在下一次请求时看到", async () => {
	const faux = createFauxModel([{ toolCalls: [{ name: "work", arguments: {} }] }, { text: "收到插话" }]);
	const agent = new Agent({ model: faux.model });
	agent.state.tools = [hookTool(() => agent.steer("用 TypeScript 写"))];
	await agent.prompt("写个脚本");
	assert.deepEqual(texts(agent.state.messages), [
		"user:写个脚本",
		"assistant:",
		"toolResult:work",
		"user:用 TypeScript 写",
		"assistant:收到插话",
	]);
});

test("followUp：排队的消息在 agent 本来要停下时处理，prompt 等到全部处理完才返回", async () => {
	const faux = createFauxModel([
		{ toolCalls: [{ name: "work", arguments: {} }] },
		{ text: "第一件事做完了" },
		{ text: "第二件事也做完了" },
	]);
	const agent = new Agent({ model: faux.model });
	agent.state.tools = [hookTool(() => agent.followUp("然后做第二件事"))];
	await agent.prompt("做第一件事");
	assert.deepEqual(texts(agent.state.messages), [
		"user:做第一件事",
		"assistant:",
		"toolResult:work",
		"assistant:第一件事做完了",
		"user:然后做第二件事",
		"assistant:第二件事也做完了",
	]);
});

test("排队的多条消息一条一条地处理", async () => {
	const faux = createFauxModel([{ text: "答 1" }, { text: "答 2" }, { text: "答 3" }]);
	const agent = new Agent({ model: faux.model });
	agent.followUp("问 2");
	agent.followUp("问 3");
	await agent.prompt("问 1");
	assert.equal(faux.requests.length, 3);
	assert.deepEqual(texts(agent.state.messages), [
		"user:问 1",
		"assistant:答 1",
		"user:问 2",
		"assistant:答 2",
		"user:问 3",
		"assistant:答 3",
	]);
});

test("queuedMessages 和 clearQueues", () => {
	const faux = createFauxModel([]);
	const agent = new Agent({ model: faux.model });
	agent.steer("插话");
	agent.followUp("排队");
	assert.equal(agent.queuedMessages.steering.length, 1);
	assert.equal(agent.queuedMessages.followUp.length, 1);
	agent.clearQueues();
	assert.deepEqual(agent.queuedMessages, { steering: [], followUp: [] });
});

test("async 的订阅者：agent 等它处理完再继续", async () => {
	const faux = createFauxModel([{ toolCalls: [{ name: "work", arguments: {} }] }, { text: "好了" }]);
	const agent = new Agent({ model: faux.model });
	const log: string[] = [];
	agent.state.tools = [hookTool(() => log.push("工具执行"))];
	agent.subscribe(async (event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			await new Promise((resolve) => setTimeout(resolve, 20)); // 比如：把消息写进文件
			log.push("保存了回复");
		}
	});
	await agent.prompt("x");
	assert.deepEqual(log, ["保存了回复", "工具执行", "保存了回复"]);
});

test("reset：清空历史和队列；运行时不能 reset", async () => {
	const faux = createFauxModel([{ text: "好", delayMs: 10 }]);
	const agent = new Agent({ model: faux.model });
	const running = agent.prompt("x");
	assert.throws(() => agent.reset(), /正在运行/);
	await running;
	agent.followUp("排队");
	agent.reset();
	assert.equal(agent.state.messages.length, 0);
	assert.equal(agent.queuedMessages.followUp.length, 0);
});

test("API key 按当前模型的服务商获取", async () => {
	const faux = createFauxModel([{ text: "好" }]);
	const seenKeys: (string | undefined)[] = [];
	const agent = new Agent({
		model: faux.model,
		getApiKey: (provider) => `key-for-${provider}`,
		streamFn: (model, context, options) => {
			seenKeys.push(options?.apiKey);
			return stream(model, context, options);
		},
	});
	await agent.prompt("x");
	assert.deepEqual(seenKeys, [`key-for-${faux.model.provider}`]);
});

test("订阅者抛出异常：prompt 把异常抛给调用者，agent 回到空闲状态", async () => {
	const faux = createFauxModel([{ text: "好" }, { text: "又好了" }]);
	const agent = new Agent({ model: faux.model });
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_end") throw new Error("界面代码有 bug");
	});
	await assert.rejects(agent.prompt("x"), /界面代码有 bug/);
	assert.equal(agent.state.isStreaming, false);
	unsubscribe();
	await agent.prompt("y");
	assert.equal(agent.state.isStreaming, false);
});
