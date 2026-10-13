# 里程碑 21：读懂真正的 pi

> 目标：带着问题去读 pi 的源码。你已经亲手写过 mini-pi 的每一个部分，现在去看看一个每天被很多人使用的 coding agent，是怎样在同一副骨架上长出那么多东西的。
>
> 这一章没有新代码。它是一份"阅读地图"和一组阅读练习，最后带你给 pi 写一个扩展。

## 你将学到

- 怎样读一个大型的代码库
- pi 的整体结构：哪些包、各管什么
- 跟着一条消息，把 pi 的主要代码走一遍
- mini-pi 省略了哪些东西，pi 为什么需要它们
- 给 pi 写一个扩展

---

## 1. 怎样读一个大型的代码库

pi 光是 `packages/coding-agent/src` 就有七万多行。从第一个文件读到最后一个，既不可能，也没有必要。下面这些方法，读任何大型项目都适用：

1. **带着一个具体的问题去读。** 不是"看看 agent-session.ts 写了什么"，而是"我按下回车之后，消息是怎么发出去的？""压缩的提示词是什么样的？"问题越具体，越容易找到答案。
2. **从入口开始，顺着调用往下走。** 程序从哪里开始运行（`cli.ts`），它调用了谁，那个函数又调用了谁……只跟着和你的问题有关的那一条路走，其他的分支先不管。
3. **先看类型和文档。** `types.ts` 往往是最好的地图：知道了数据长什么样，代码就好懂一半。pi 的 `packages/coding-agent/docs/` 里有几十篇文档，[how-pi-works.md](../../packages/coding-agent/docs/how-pi-works.md) 用一页纸讲了 pi 的整体工作方式，先读它。
4. **用好工具。** 编辑器的"跳转到定义"（VS Code 里是 F12）、"查找所有引用"（Shift+F12）、全局搜索（Ctrl+Shift+F，或者命令行里的 `grep -rn "关键字" packages/`）。想知道某一行**为什么**这样写，用 `git log -p 文件名` 或 `git blame` 找到当初的提交和它的说明。
5. **读测试。** 测试告诉你一个函数应该怎么用、作者担心哪些边界情况。pi 的测试在每个包的 `test/` 目录里。
6. **边读边记。** 画出调用链：`A() → B() → C()`，每一步记下文件名。读完一条路，你就有了一张自己的地图。

你比大多数第一次读 pi 的人都有优势：**你知道每个部分要解决什么问题**，因为你自己解决过一遍。读的时候不断问自己："这里和我写的有什么不同？它多处理了什么情况？为什么？"

## 2. pi 的地图

pi 是一个 **monorepo**：一个 git 仓库里放着好几个 npm 包，每个包在 `packages/` 下有自己的目录。

| 包 | npm 包名 | 作用 | 源码行数 |
| --- | --- | --- | --- |
| `ai` | `@earendil-works/pi-ai` | 统一的大模型接口：消息类型、事件流、几十家服务商 | 约 27000 |
| `agent` | `@earendil-works/pi-agent-core` | agent loop 和 `Agent` 类 | 约 2500 |
| `tui` | `@earendil-works/pi-tui` | 终端界面框架：差分渲染、编辑器、Markdown | 约 19500 |
| `coding-agent` | `@earendil-works/pi-coding-agent` | pi 本身：工具、会话、压缩、交互模式、扩展系统 | 约 76000 |
| `mcp` | `@earendil-works/pi-mcp` | MCP（Model Context Protocol）客户端：连接外部的工具服务器 | 约 3300 |
| `codemode` | `@earendil-works/pi-codemode` | 让模型写一段 JavaScript 来调用工具，在沙箱里执行 | 约 3000 |
| `chord`、`durable`、`env`、`telemetry`、`evals` | | 更新的基础设施：插件运行时、持久化的任务运行时、远程执行环境、遥测、评测 | |

前四个包就是 mini-pi 的四个部分：

| mini-pi | pi | 行数对比 |
| --- | --- | --- |
| `src/ai/` | `packages/ai` | 1750 : 27000 |
| `src/agent/` | `packages/agent` | 830 : 2500 |
| `src/tui/` | `packages/tui` | 2000 : 19500 |
| `src/tools/`、`src/core/`、`src/modes/`、`src/cli*` | `packages/coding-agent` | 3800 : 76000 |

注意 `agent` 包：pi 的 agent loop 只比我们的大三倍。**核心的循环就是这么小**，你在里程碑 09 写的那一百多行，就是整个 coding agent 的心脏。多出来的几万行，都在边缘：更多的服务商、更多的界面功能、扩展系统、各种真实世界里的边界情况。

`ai` 包为什么有两万七千行？打开 [packages/ai/src/](../../packages/ai/src/) 看看：`api/` 里是各种协议的实现（OpenAI 的两种接口、Anthropic、Google、Bedrock、Mistral……），`providers/` 里是几十家服务商各自的配置和模型表。我们只实现了两种协议，加一个假模型。

## 3. 跟着一条消息走一遍

问题："我在 pi 的输入框里输入'修复测试'，按下回车，到屏幕上出现回答，中间经过了哪些代码？"

下面是答案的路线图。每一步都打开对应的文件，找到那个函数，和 mini-pi 里对应的代码对照着读。

| 步骤 | pi | mini-pi |
| --- | --- | --- |
| ① 启动 | [coding-agent/src/cli.ts](../../packages/coding-agent/src/cli.ts) 调用 [main.ts](../../packages/coding-agent/src/main.ts) 的 `main()` | `src/cli.ts` 的 `main()` |
| ② 组装 | `main()` 里的 `createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime`：读取设置、模型、工具、扩展，创建会话 | `new Agent(...)`、`new AgentSession(...)` |
| ③ 进入交互模式 | `main()` 里 `new InteractiveMode(runtime, ...)`；[interactive-mode.ts](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) 的 `run()` 里有一个主循环：`await this.getUserInput()`，然后 `await this.session.prompt(userInput)` | `runInteractiveMode`，`submit` → `prompt` |
| ④ 会话处理输入 | [agent-session.ts](../../packages/coding-agent/src/core/agent-session.ts) 的 `prompt()`：扩展的输入处理、提示词模板、技能、压缩检查……最后 `this.agent.prompt(messages)` | `AgentSession.prompt` |
| ⑤ agent 运行 | [agent/src/agent.ts](../../packages/agent/src/agent.ts) 的 `prompt()` → [agent-loop.ts](../../packages/agent/src/agent-loop.ts) 的 `runAgentLoop` → `runLoop` | `Agent.run` → `runAgentLoop` |
| ⑥ 请求模型 | `agent-loop.ts` 的 `streamAssistantResponse`：先 `transformContext`、`convertToLlm`，再调用流式函数（默认是 pi-ai 的 `streamSimple`，在 [ai/src/compat.ts](../../packages/ai/src/compat.ts)） | `streamAssistantResponse` → `stream` |
| ⑦ 协议和流式解析 | [ai/src/api/openai-completions.ts](../../packages/ai/src/api/openai-completions.ts)（或 `anthropic-messages.ts`……）：组装请求、解析 SSE，通过 [utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts) 发出事件 | `providers/openai.ts`、`sse.ts`、`event-stream.ts` |
| ⑧ 执行工具 | `agent-loop.ts` 的 `executeToolCalls`（并行或顺序）→ 工具的 `execute`，比如 [core/tools/bash.ts](../../packages/coding-agent/src/core/tools/bash.ts) | `executeParallel` → `tools/bash.ts` |
| ⑨ 事件回流、保存 | `Agent` 发出事件 → `agent-session.ts` 的 `_handleAgentEvent`：`message_end` 时 `this.sessionManager.appendMessage(event.message)` 写进 JSONL → 转发给订阅者 | `AgentSession` 的构造函数里订阅 agent |
| ⑩ 画到屏幕上 | `InteractiveMode.handleEvent` 更新组件 → `ui.requestRender()` → [tui/src/tui-main-screen.ts](../../packages/tui/src/tui-main-screen.ts) 的 `doRender` | `handleEvent` → `TUI.doRender` |

走完一遍，你会发现：**每一步你都认识**。pi 在每一步上都多做了很多事情（第 ④ 步尤其多），但骨架和你写的一模一样。

> 小技巧：在一个陌生的大函数里，先找它**最后**调用了什么（比如 `prompt()` 最后调用了 `this.agent.prompt`），再回头看前面都做了哪些准备。

## 4. 每个里程碑在 pi 里的位置

每一章最后的"对照 pi 源码"都列出了对应的文件。这里汇总成一张索引，方便你按主题查找：

| 里程碑 | 主题 | pi 里看哪里 |
| --- | --- | --- |
| 05~07 | 消息类型、流式解析、服务商 | `ai/src/types.ts`、`ai/src/utils/event-stream.ts`、`ai/src/api/`、`ai/src/providers/` |
| 08 | 工具调用、参数校验 | `ai/src/utils/validation.ts`、`ai/src/api/transform-messages.ts` |
| 09~10 | agent loop、Agent 类 | `agent/src/agent-loop.ts`、`agent/src/agent.ts` |
| 11~12 | 文件工具、bash | `coding-agent/src/core/tools/`、`coding-agent/src/utils/shell.ts` |
| 13 | 系统提示词、命令行 | `coding-agent/src/core/system-prompt.ts`、`coding-agent/src/cli/`、`coding-agent/src/main.ts` |
| 14 | 会话 | `coding-agent/src/core/session-manager.ts`、`docs/session-format.md` |
| 15 | 上下文压缩 | `coding-agent/src/core/compaction/` |
| 16~18 | 终端、界面框架、编辑器、Markdown | `tui/src/` |
| 19 | 交互模式 | `coding-agent/src/modes/interactive/` |
| 20 | 重试、设置、选择模型 | `ai/src/utils/retry.ts`、`coding-agent/src/core/settings-manager.ts`、`modes/interactive/components/model-selector.ts` |

## 5. mini-pi 省略了什么，pi 为什么需要它们

课程开头说过，mini-pi 刻意省略了很多东西。现在你有能力理解它们了。每一项都写了它解决什么问题、从哪里开始读。

**扩展（extensions）。** 每个人的工作方式都不一样：有人要在执行危险命令前确认（我们直接写进了 mini-pi），有人要保护 `.env` 文件，有人想加一个查询公司内部系统的工具。如果都写进 pi 本身，pi 会越来越臃肿。所以 pi 提供了一个扩展系统：扩展是一个 TypeScript 文件，可以注册工具、命令、快捷键、事件处理函数、界面组件，甚至新的服务商。从 [docs/extensions.md](../../packages/coding-agent/docs/extensions.md) 开始读，[examples/extensions/](../../packages/coding-agent/examples/extensions/) 里有将近八十个例子，实现在 [core/extensions/](../../packages/coding-agent/src/core/extensions/)。

**技能（skills）。** 有些知识只在特定的任务里需要（比如"怎样发布一个新版本"）。全部写进 AGENTS.md，每次请求都要带着它们，浪费上下文。技能的做法是：系统提示词里只放每个技能的一句话说明，模型需要的时候再去读完整的内容。见 [docs/skills.md](../../packages/coding-agent/docs/skills.md)、[core/skills.ts](../../packages/coding-agent/src/core/skills.ts)。

**会话树。** 我们在里程碑 14 给每条记录加了 `id` 和 `parentId`，却只用来排成一条线。pi 真正把它用成了一棵树：可以回到之前的某一条消息，从那里开始一个新的分支（`/tree`、`/fork`），原来的对话还在。见 [docs/sessions.md](../../packages/coding-agent/docs/sessions.md) 和 [docs/session-format.md](../../packages/coding-agent/docs/session-format.md)。

**几十家服务商和模型数据。** 模型表不是手写的：[packages/ai/scripts/generate-models.ts](../../packages/ai/scripts/generate-models.ts) 从各家的数据生成 `models.generated.ts`，包括价格、上下文窗口、是否支持图片和思考。还有用订阅账号登录的 OAuth（`ai/src/oauth.ts`），以及大量的兼容性处理（`ai/src/compat/`）：同样号称"兼容 OpenAI"，每家都有自己的小差别。

**思考级别。** 我们只是把思考过程显示出来。pi 可以控制模型思考的深度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（[agent/src/types.ts](../../packages/agent/src/types.ts) 的 `ThinkingLevel`），并且把它翻译成每家服务商自己的参数（比如 OpenAI 兼容接口的 `reasoning_effort`）。

**RPC 模式和 SDK。** 让别的程序使用 pi：编辑器插件可以启动 `pi --mode rpc`，通过标准输入输出收发 JSON 命令和事件；TypeScript 程序可以直接用 SDK 在进程里创建会话。见 [docs/rpc.md](../../packages/coding-agent/docs/rpc.md)、[docs/sdk.md](../../packages/coding-agent/docs/sdk.md)。我们的 print 模式的 `--mode json`，就是这个方向的第一步。

**图片。** 模型可以看图，终端也可以显示图片（kitty、iTerm2 的图片协议，见 [tui/src/terminal-image.ts](../../packages/tui/src/terminal-image.ts)）。

**全屏模式。** 除了我们实现的主屏幕模式，pi 还可以在备用屏幕上运行，自己实现滚动和搜索（[tui/src/tui-alt-screen.ts](../../packages/tui/src/tui-alt-screen.ts)）。

**MCP。** 一个标准的协议，让 agent 连接外部的"工具服务器"（数据库、浏览器、各种 SaaS）。见 [docs/mcp.md](../../packages/coding-agent/docs/mcp.md) 和 `packages/mcp`。

**安全和信任。** pi 不会悄悄拦截命令，它的立场写在 [docs/security.md](../../packages/coding-agent/docs/security.md) 里；打开一个陌生的项目时，pi 会先问你是否信任它，再加载项目里的设置和扩展（`core/project-trust.ts`）。

## 6. 阅读练习

每个问题都能在 pi 的源码或文档里找到答案。先自己找，再看参考答案。

1. 单独收到一个 ESC 时，pi 等多久才认定它是 Esc 键？通过 SSH 连接时呢？为什么不一样？
2. pi 的 bash 工具怎样结束一个命令和它启动的所有子进程？在 Windows 上呢？
3. edit 工具找不到要替换的文字时，pi 给模型的错误信息是什么？和我们的比，它强调了什么？
4. pi 的压缩提示词要求总结包含哪几个部分？和我们在里程碑 15 写的比较一下。
5. agent loop 抛出异常时，pi 的 `Agent` 怎么处理？和我们的做法有什么不同？（提示：里程碑 10 的"对照 pi"提过。）
6. pi 的会话文件里一共有几种记录？哪几种是我们没有的？
7. 一个扩展怎样阻止某个工具调用？找一个现成的例子。
8. 用 `git log` 找出 `packages/tui/src/tui-main-screen.ts` 最近的几次修改，挑一次读一读它的说明和改动：它修复了什么问题？

<details>
<summary>参考答案</summary>

1. [tui/src/terminal.ts](../../packages/tui/src/terminal.ts) 的 `resolveEscapeTimeoutMs`：默认 10 毫秒，通过 SSH 连接时 100 毫秒，也可以用环境变量 `PI_TUI_ESC_TIMEOUT` 设置。网络会把一个转义序列拆成几块、隔一段时间才送到，等得太短会把方向键误认成 Esc 加几个字母。（我们的 mini-pi 用的是 50 毫秒。）
2. [utils/shell.ts](../../packages/coding-agent/src/utils/shell.ts) 的 `killProcessTree`：在 Unix 上 `process.kill(-pid, "SIGKILL")` 杀掉整个进程组（和我们一样），失败了再只杀子进程本身；在 Windows 上调用系统的 `taskkill /F /T /PID`。
3. [core/tools/edit-diff.ts](../../packages/coding-agent/src/core/tools/edit-diff.ts)：`Could not find the exact text in <path>. The old text must match exactly including all whitespace and newlines.`——强调**包括空白和换行**必须完全一致，因为模型最常犯的错误就是缩进、空格不对。
4. [core/compaction/compaction.ts](../../packages/coding-agent/src/core/compaction/compaction.ts) 的 `SUMMARIZATION_PROMPT`：Goal、Constraints & Preferences、Progress（Done / In Progress / Blocked）、Key Decisions、Next Steps、Critical Context，并且要求保留准确的文件路径、函数名和错误信息。我们的中文提示词就是照着它的结构写的。
5. [agent/src/agent.ts](../../packages/agent/src/agent.ts) 的 `handleRunFailure`：造一条 `stopReason: "error"` 的助手消息，发出 `message_end`、`turn_end`、`agent_end`，`prompt()` 正常返回。我们选择了更简单的做法：恢复空闲状态，把异常抛给调用者。
6. [docs/session-format.md](../../packages/coding-agent/docs/session-format.md) 的 Entry Types：会话头之外有十一种——消息、模型变更、思考级别变更、用量、压缩、上下文编辑、分支总结、自定义记录、自定义消息、标签、会话信息。我们只有会话头、消息、模型变更、压缩。
7. 在 `tool_call` 事件里返回 `{ block: true, reason: "..." }`。例子：[examples/extensions/protected-paths.ts](../../packages/coding-agent/examples/extensions/protected-paths.ts)（阻止写入 `.env`、`.git/`）、[permission-gate.ts](../../packages/coding-agent/examples/extensions/permission-gate.ts)（危险命令先确认）。
8. `git log --oneline -10 -- packages/tui/src/tui-main-screen.ts`，再用 `git show <提交号>` 看完整的改动。答案取决于你看到的提交——重要的是养成这个习惯：**代码为什么是现在这个样子，答案常常在提交记录里**。

</details>

## 7. 动手：给 pi 写一个扩展

读懂了，就动手改一改。最好的入口是扩展：不用修改 pi 本身的代码。

**准备**：安装 pi（`npm install -g @earendil-works/pi-coding-agent`），或者直接从这个仓库运行（仓库根目录 `npm install --ignore-scripts`，然后用 `./pi-test.sh` 代替 `pi`）。

**第一个扩展：一个命令。** 新建 `hello.ts`（来自 [docs/extensions.md](../../packages/coding-agent/docs/extensions.md)）：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Show a greeting",
		handler: async (name, ctx) => {
			ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
		},
	});
}
```

运行 `pi --extension ./hello.ts`，输入 `/hello 小明`。和我们在里程碑 20 写的命令表比一比：`name`、`description`、`handler`，几乎一样。

**第二个扩展：一个工具。** 参考 [examples/extensions/hello.ts](../../packages/coding-agent/examples/extensions/hello.ts)，写一个 `count_lines` 工具：参数是文件路径，返回文件的行数。注意 pi 用 TypeBox（`Type.Object`、`Type.String`）描述参数，最后生成的还是 JSON Schema——和我们在里程碑 08 手写的一样。然后让模型用它："src 目录里哪个文件最长？"

**第三个扩展：一个保护。** 不许模型修改 `package-lock.json`：监听 `tool_call` 事件，`write` 或 `edit` 的路径是它时，返回 `{ block: true, reason: "..." }`。（答案的思路就在上一节的练习 7 里。）

做完这三个，你就同时用到了扩展系统的三种主要能力：命令、工具、事件。再去 [examples/extensions/README.md](../../packages/coding-agent/examples/extensions/README.md) 挑几个感兴趣的读一读：`todo.ts`（带状态的工具）、`plan-mode/`（只读的"计划模式"）、`subagent/`（让 agent 再启动一个 agent）……

## 8. 下一步

如果你想给 pi 贡献代码，先读仓库根目录的 [CONTRIBUTING.md](../../CONTRIBUTING.md) 和 [AGENTS.md](../../AGENTS.md)：它们说明了提交 issue 和 PR 的规则、代码风格、怎样运行检查和测试。

最后一章是整门课的毕业考试：合上教程，从一个空目录开始，不借助 AI，把 mini-pi 重新写一遍。

---

上一步：[里程碑 20：打磨](../20-polish/README.md) · 下一步：[里程碑 22：毕业项目](../22-capstone/README.md)
