# 假模型服务器（fake-llm）

一个只用 Node.js 内置模块写成的"假大模型"。它的作用只有一个：**让你在没有 API key、不花钱、甚至断网的情况下，也能运行课程里的每一个程序。**

它会假装自己是一个大模型服务，听得懂两种协议：

| 协议 | 地址 | 谁在用 |
| --- | --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | OpenAI、DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama…… |
| Anthropic Messages | `POST /v1/messages` | Anthropic，以及部分国内厂商提供的兼容接口 |

两种协议都支持流式（`"stream": true`）和非流式。

## 启动

在课程仓库根目录运行（任何目录都行，路径写对即可）：

```bash
node learn/tools/fake-llm/server.ts
```

看到下面的输出就说明启动成功了：

```
假模型服务器已启动：http://localhost:4000

  OpenAI 兼容地址（LLM_BASE_URL）：   http://localhost:4000/v1
  Anthropic 兼容地址：                http://localhost:4000
  API key：任意非空字符串，例如 fake
  ...
```

保持这个终端窗口开着，另开一个终端运行你的程序。服务器每收到一个请求，都会打印一行日志，你可以清楚地看到"你的程序发了什么、假模型回了什么"。

学习时强烈建议加上 `--verbose`，它会把每个请求的完整 JSON 打印出来：

```bash
node learn/tools/fake-llm/server.ts --verbose
```

## 三种"大脑"

用 `--mode` 选择：

- `rules`（默认）：没有工具时复读你的话；请求里带了工具时，用简单的规则识别你的意图并发出工具调用。
- `echo`：永远复读最后一条用户消息。
- `script`：按照剧本文件依次返回预设的回复，写自动化测试时用。

### rules 模式能听懂的话

前提是你的请求里提供了对应名字的工具：

| 你说 | 假模型调用的工具 |
| --- | --- |
| 现在几点 | `get_current_time` |
| 计算 23*47 | `calculate`，参数 `{"expression": "23*47"}` |
| 读取 package.json | `read`，参数 `{"path": "package.json"}` |
| 列出 src | `ls`（没有 `ls` 就用 `bash` 执行 `ls src`） |
| 运行 node --version | `bash`，参数 `{"command": "node --version"}` |
| 写入 a.txt 内容 你好 | `write`，参数 `{"path": "a.txt", "content": "你好"}` |
| 把 a.txt 里的"你好"改成"再见" | `edit` |

用"然后"连接多个步骤，假模型会**一步一步**执行（每收到一个工具结果，再发下一个工具调用），最后总结。例如：

```
读取 package.json 然后 运行 node --version
```

用"同时"连接，假模型会在**一次回复里并行**发出多个工具调用：

```
现在几点 同时 计算 23*47
```

这两个例子在学习 Agent Loop（里程碑 09、10）时非常有用。

## 剧本模式

剧本是一个 JSON 数组，每个元素是一次回复：

```json
[
	{ "text": "我先看看当前目录里有什么。", "toolCalls": [{ "name": "bash", "arguments": { "command": "ls" } }] },
	{ "text": "看完了。" }
]
```

每条回复可以包含：

| 字段 | 含义 |
| --- | --- |
| `text` | 正文 |
| `thinking` | 思考过程（OpenAI 协议下以 `reasoning_content` 发出） |
| `toolCalls` | 工具调用列表：`{ "name": "...", "arguments": { ... } }` |
| `error` | 返回一个 HTTP 错误：`{ "status": 429, "message": "...", "type": "rate_limit_error" }` |
| `finishReason` | 设为 `"length"` 可以模拟"输出被截断" |
| `delayMs` | 这条回复的流式片段间隔 |

```bash
node learn/tools/fake-llm/server.ts --script learn/tools/fake-llm/scripts/tool-then-answer.json
```

剧本用完之后，服务器会返回 500 错误，提醒你"剧本不够长"。`scripts/` 目录里有几个例子。

## 其他选项

```
--port <端口>            监听端口，默认 4000
--delay <毫秒>           流式片段之间的延迟，默认 30（设成 0 最快）
--context-window <数字>  模拟上下文窗口，请求超过它就返回"上下文过长"错误（里程碑 15 用）
--no-auth                不检查 API key
```

## 在代码里启动

测试代码可以直接启动它，端口用 0 表示"随便找一个空闲端口"：

```ts
import { startFakeLlm } from "../../tools/fake-llm/server.ts";

const server = await startFakeLlm({ port: 0, delayMs: 0, script: [{ text: "你好" }] });
// server.url 形如 http://127.0.0.1:53124
// server.requests 记录了收到的每个请求
await server.close();
```

## 为什么值得读一读它的源码

你在课程里写的是**客户端**：发请求、解析流式响应。而 `server.ts` 是**服务器端**：它展示了 SSE（Server-Sent Events）的每一行是怎么"造出来"的。对照着读，你会对协议理解得更透。

它的测试在 `server.test.ts`，运行：

```bash
node --test learn/tools/fake-llm/server.test.ts
```
