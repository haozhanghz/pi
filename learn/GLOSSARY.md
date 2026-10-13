# 术语表

课程里出现的专业名词，按第一次出现的顺序排列。"见"一栏是讲解它的里程碑。

遇到不认识的词，先在这里查一个大概的意思，再回到对应的章节看完整的讲解。

## 准备（里程碑 00~02）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 终端（terminal） | 用文字和电脑打交道的窗口：输入一行命令，按回车，看结果。 | [00](00-setup/README.md) |
| shell | 终端里负责理解和执行命令的程序，比如 bash、zsh。 | [00](00-setup/README.md) |
| 工作目录（cwd） | current working directory，程序运行时"所在"的目录，相对路径从这里算起。`pwd` 命令显示它。 | [00](00-setup/README.md) |
| 绝对路径、相对路径 | 从根目录 `/` 开始写的完整路径；从工作目录开始算的路径。`~` 表示你的主目录。 | [00](00-setup/README.md) |
| Node.js | 在浏览器之外运行 JavaScript 的程序。22.18 以上的版本可以直接运行 `.ts` 文件。 | [00](00-setup/README.md) |
| npm | Node 自带的包管理器。`npm install` 安装依赖，`npm test` 运行 `package.json` 里的 `test` 脚本。 | [00](00-setup/README.md) |
| `package.json` | 项目的说明书：名字、版本、脚本、依赖。 | [00](00-setup/README.md) |
| 依赖（dependency） | 项目用到的别人写的包。mini-pi 没有运行时依赖，只在开发时用到 `typescript` 和 `@types/node`。 | [00](00-setup/README.md) |
| TypeScript | 加上了类型的 JavaScript。 | [00](00-setup/README.md) |
| 类型检查 | 不运行程序，检查代码里的类型是否对得上，由 `tsc` 完成。Node 运行 `.ts` 时只是把类型删掉，并不检查，所以"能运行"不等于"类型正确"。 | [00](00-setup/README.md) |
| 可擦除的语法（erasable syntax） | 删掉类型之后就是合法 JavaScript 的 TypeScript 语法。Node 只会删除类型，所以 `enum` 这类需要生成代码的语法不能用。 | [00](00-setup/README.md)、[01](01-typescript/README.md) |
| git、提交（commit） | git 是版本管理工具；一次提交就是给代码存一次档，随时可以回看或恢复。 | [00](00-setup/README.md) |
| 调用栈（stack trace） | 程序出错时打印的函数调用链。从上往下读，找到第一行属于你自己代码的位置。 | [00](00-setup/README.md) |
| JSON | 用文字表示数据的格式。`JSON.stringify` 把对象变成文字，`JSON.parse` 反过来。和大模型通信全靠它。 | [01](01-typescript/README.md) |
| `interface`、`type` | 给数据的"形状"起一个名字：有哪些字段，每个字段是什么类型。 | [01](01-typescript/README.md) |
| 联合类型（union type） | "几种类型之一"，比如 `string \| number`。 | [01](01-typescript/README.md) |
| 可辨识联合（discriminated union） | 每种成员都有一个取值不同的字段（比如 `role`、`type`），看这个字段就知道是哪一种。mini-pi 的消息、内容块、事件都是这样定义的。 | [01](01-typescript/README.md) |
| 类型收窄（narrowing） | 用 `if`、`switch` 检查之后，TypeScript 就知道一个联合类型的值具体是哪一种。 | [01](01-typescript/README.md) |
| `unknown` | "不知道是什么"的类型，用之前必须先检查。从网络、文件读来的数据都应该先当成 `unknown`。 | [01](01-typescript/README.md) |
| 泛型（generic） | 类型的参数，比如 `EventStream<T>` 里的 `T`：写一次，适用于多种类型。 | [01](01-typescript/README.md) |
| 模块（module） | 一个文件就是一个模块，用 `export` 导出，用 `import` 导入。 | [01](01-typescript/README.md) |
| 异常（exception） | `throw` 抛出的错误。它会一路向上传，直到被 `try/catch` 接住；没有人接住，程序就崩溃。 | [01](01-typescript/README.md) |
| 异步（asynchronous） | 发起一个慢操作（网络请求、读文件）之后不干等，先做别的事，操作完成后再回来处理结果。 | [02](02-async/README.md) |
| 事件循环（event loop） | Node 执行异步代码的机制：做完一个任务，再从队列里取下一个。同一时刻只有一段 JavaScript 在运行。 | [02](02-async/README.md) |
| `Promise`、`async`/`await` | `Promise` 代表"将来才有的结果"；`await` 等它完成，让异步代码写起来像普通代码。 | [02](02-async/README.md) |
| 异步生成器（async generator） | 用 `async function*` 定义、用 `for await` 读取，能"一点一点"地产出值。流式输出的核心。 | [02](02-async/README.md) |
| `AbortController`、`AbortSignal` | 取消异步操作的标准办法：controller 发出"取消"，signal 传给要被取消的操作。 | [02](02-async/README.md) |
| 回调（callback）、订阅（subscribe） | 把一个函数交给别人，事情发生时由别人调用它。`agent.subscribe(listener)` 就是订阅 agent 的事件。 | [02](02-async/README.md) |
| HTTP | 网络上"请求—响应"的协议。请求有方法（GET、POST）、地址、请求头、请求体；响应有状态码、响应头、响应体。 | [02](02-async/README.md) |
| 状态码（status code） | 响应的结果：200 成功，400 请求有误，401 没有认证，429 请求太频繁，5xx 服务器出错。 | [02](02-async/README.md)、[03](03-first-call/README.md) |

## 和模型说话（里程碑 03~07）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 大模型（LLM） | large language model，读入一段文字、预测接下来的文字的程序。我们通过 API 使用它。 | [03](03-first-call/README.md) |
| API | 程序之间约定好的调用方式。大模型的 API 就是一个 HTTP 地址：发过去一组消息，返回模型的回答。 | [03](03-first-call/README.md) |
| API key | 调用 API 的密码，按用量收费。不能写进代码、不能提交到 git，要放在环境变量或 `.env` 文件里。 | [03](03-first-call/README.md) |
| 环境变量（environment variable） | 运行程序时附带的一组"名字=值"，程序用 `process.env.名字` 读取。 | [03](03-first-call/README.md) |
| `.env` 文件 | 保存环境变量的文本文件，运行时用 `node --env-file=.env` 让 Node 读取。一定要加进 `.gitignore`。 | [03](03-first-call/README.md) |
| curl | 在命令行里发 HTTP 请求的工具，用来快速试验 API。 | [03](03-first-call/README.md) |
| token | 模型处理文字的单位，可能是一个英文单词、半个单词、一个汉字或者半个汉字。按 token 计费，上下文窗口也按 token 计算。 | [03](03-first-call/README.md) |
| 无状态（stateless） | 模型不记得之前的请求。多轮对话靠程序每次把完整的历史都发过去。 | [03](03-first-call/README.md)、[04](04-chat/README.md) |
| 消息（message）、角色（role） | 对话由消息组成，每条消息有一个角色：`system`（系统提示词）、`user`（用户）、`assistant`（模型）、`tool`（工具结果）。 | [03](03-first-call/README.md) |
| 服务商（provider） | 提供模型 API 的公司：OpenAI、Anthropic、DeepSeek…… | [03](03-first-call/README.md)、[07](07-providers/README.md) |
| 地址（base URL） | API 的根地址，比如 `https://api.deepseek.com/v1`，后面再接上 `/chat/completions`。 | [03](03-first-call/README.md) |
| 上下文（context） | 一次请求发给模型的全部内容：系统提示词、对话历史、工具的定义。 | [04](04-chat/README.md)、[06](06-ai-types/README.md) |
| 上下文窗口（context window） | 模型一次最多能处理的 token 数，包括系统提示词、全部历史和这次的回答。 | [04](04-chat/README.md)、[15](15-compaction/README.md) |
| 流式输出（streaming） | 模型一边生成一边发送，回答一个字一个字地出现。 | [05](05-streaming/README.md) |
| SSE（Server-Sent Events） | 流式响应的格式：一行行的 `data: ...`，空行表示一个事件结束。 | [05](05-streaming/README.md) |
| UTF-8 | 最常用的文字编码，一个汉字占 3 个字节。网络数据可能把一个汉字切成两半，所以要用 `TextDecoder` 的流式模式解码。 | [05](05-streaming/README.md) |
| 首字延迟（time to first token） | 从发出请求到收到第一个字的时间。 | [05](05-streaming/README.md) |
| 推理模型、思考（thinking） | 回答之前先输出一段"思考过程"的模型。思考的内容和正文分开发送。 | [05](05-streaming/README.md)、[08](08-tools/README.md) |
| 适配器（adapter） | 把各家不同的协议翻译成统一的类型。上层代码只认识统一的类型，换服务商不用改。 | [06](06-ai-types/README.md) |
| 内容块（content block） | 一条消息的组成部分：文字、思考、工具调用。 | [06](06-ai-types/README.md) |
| 事件流（event stream） | 适配器输出的一串事件：`start`，每个内容块的 `start`、`delta`、`end`，最后是 `done` 或 `error`。 | [06](06-ai-types/README.md) |
| 停止原因（stop reason） | 回答为什么结束：说完了（`stop`）、要调用工具（`toolUse`）、太长被截断（`length`）、出错（`error`）、被取消（`aborted`）。 | [06](06-ai-types/README.md)、[08](08-tools/README.md) |
| 用量（usage） | 一次请求用了多少输入和输出 token，花了多少钱，其中多少命中了缓存。 | [06](06-ai-types/README.md) |
| 测试（test） | 自动检查代码行为的代码。课程用 Node 自带的 `node:test`，用 `node --test` 运行。 | [06](06-ai-types/README.md) |
| 协议 | 请求和响应的具体格式。课程实现了两种：OpenAI Chat Completions 和 Anthropic Messages。 | [03](03-first-call/README.md)、[07](07-providers/README.md) |
| 模型表（model registry） | 用一张表描述服务商和模型（地址、协议、价格、上下文窗口），加一个模型只要加一行。 | [07](07-providers/README.md) |
| 假模型（fake model） | 不联网、按剧本回答的"模型"，写测试时用来代替真正的模型。课程还提供了一个[假模型服务器](tools/fake-llm/README.md)。 | [07](07-providers/README.md) |

## 让模型动手（里程碑 08~10）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 工具（tool） | 程序提供给模型的能力：名字、说明、参数的 JSON Schema，以及执行它的函数。 | [08](08-tools/README.md) |
| 工具调用（tool call） | 模型在回答里**请求**调用某个工具并给出参数，由程序负责**执行**。 | [08](08-tools/README.md) |
| 工具结果（tool result） | 工具执行的输出，作为一条消息发回给模型。每个结果用 id 对应一个调用，必须一一配对。 | [08](08-tools/README.md) |
| JSON Schema | 描述 JSON 数据结构的格式：有哪些字段、什么类型、哪些必填。 | [08](08-tools/README.md) |
| agent | 能自己决定下一步、多次调用工具来完成任务的程序。本质是一个循环。 | [09](09-agent-loop/README.md) |
| agent loop | agent 的核心循环：请求模型；有工具调用就执行，把结果加进对话，再请求模型……直到模型不再调用工具。 | [09](09-agent-loop/README.md) |
| 轮（turn） | 循环的一圈：一次模型回复，加上执行它调用的工具。 | [09](09-agent-loop/README.md) |
| 事件（event） | agent 运行时发出的通知：`agent_start`、`turn_start`、`message_update`、`tool_execution_end`……界面靠事件实时更新。 | [09](09-agent-loop/README.md)、[10](10-agent-class/README.md) |
| 参数校验（validation） | 用 JSON Schema 检查模型给的参数。不合格就把错误告诉模型，让它改正。 | [09](09-agent-loop/README.md) |
| 取消（abort） | 停止正在进行的请求和工具，比如用户按了 Esc。停下之后，对话历史必须仍然合法。 | [09](09-agent-loop/README.md)、[10](10-agent-class/README.md) |
| 插话（steering） | agent 运行时用户发的消息。它在当前这一步的工具执行完之后送给模型，让模型马上调整方向。 | [10](10-agent-class/README.md) |
| 排队（follow-up） | 等 agent 完全停下来之后才发送的消息。 | [10](10-agent-class/README.md) |
| 并行执行 | 模型一次调用多个工具时，同时执行它们，但结果按调用的顺序放回对话。 | [10](10-agent-class/README.md) |

## 会写代码的 Agent（里程碑 11~13）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 截断（truncation） | 工具的输出有上限（2000 行或 50KB），超出的部分去掉，并告诉模型怎样查看剩下的部分。 | [11](11-file-tools/README.md) |
| 精确替换 | `edit` 工具的做法：给出要替换的原文 `oldText` 和新的文字 `newText`，原文必须在文件里只出现一次。 | [11](11-file-tools/README.md) |
| 换行符 | Linux 和 macOS 用 `\n`，Windows 常用 `\r\n`。修改文件时要保持原来的风格。 | [11](11-file-tools/README.md) |
| BOM | 字节顺序标记，有的编辑器在文件开头写入的一个看不见的字符。 | [11](11-file-tools/README.md) |
| diff | 两段文字的差异：`-` 开头的是删除的行，`+` 开头的是新增的行。课程用最长公共子序列（LCS）算法实现。 | [11](11-file-tools/README.md) |
| 进程（process） | 一个正在运行的程序。`spawn` 启动一个子进程。 | [12](12-bash/README.md) |
| 标准输入、标准输出、标准错误 | stdin、stdout、stderr，每个进程都有的三个数据通道：读取输入、输出结果、输出错误和提示信息。 | [12](12-bash/README.md)、[13](13-system-prompt/README.md) |
| 退出码（exit code） | 进程结束时返回的数字：0 表示成功，其他数字表示失败。 | [12](12-bash/README.md)、[13](13-system-prompt/README.md) |
| 信号（signal） | 操作系统发给进程的通知：`SIGINT`（Ctrl+C）、`SIGTERM`（请退出）、`SIGKILL`（强制结束）。 | [12](12-bash/README.md) |
| 进程组（process group） | 一个进程和它启动的所有子进程。取消命令时要终止整个组，不然子进程会留下来继续运行。 | [12](12-bash/README.md) |
| 钩子（hook） | 在某个时机被调用、可以由外部提供的函数，比如执行工具之前的 `beforeToolCall`。 | [12](12-bash/README.md) |
| 提示词注入（prompt injection） | 文件或网页里藏着写给模型的"指令"，诱导它做坏事。识别危险命令挡不住它，真正的保护是限制 agent 能访问的东西（容器、虚拟机、沙箱）。 | [12](12-bash/README.md) |
| 系统提示词（system prompt） | 每次请求最前面的说明：你是谁、有哪些工具、要遵守什么规则、项目的信息。 | [03](03-first-call/README.md)、[13](13-system-prompt/README.md) |
| XML 标签 | `<cwd>...</cwd>` 这样的标记。系统提示词用它分段，模型更容易分清每一部分。 | [13](13-system-prompt/README.md) |
| 提示词缓存（prompt caching） | 服务商缓存请求的开头部分，开头相同的请求更便宜、更快。所以系统提示词要保持稳定。 | [06](06-ai-types/README.md)、[13](13-system-prompt/README.md) |
| `AGENTS.md` | 写给 agent 的项目说明书：怎么运行测试、代码风格、注意事项。启动时自动加进系统提示词。 | [13](13-system-prompt/README.md) |
| print 模式、交互模式 | print 模式处理完消息就退出，适合在脚本里用；交互模式是一来一回的对话界面。 | [13](13-system-prompt/README.md) |
| 依赖注入（dependency injection） | 函数不自己去拿它依赖的东西（比如 `process.stdin`），而是由调用者传进来，测试时就能换成假的。 | [13](13-system-prompt/README.md) |
| 端到端测试（end-to-end test） | 像用户一样运行整个程序来测试，而不是只测试一个函数。 | [13](13-system-prompt/README.md) |

## 记忆与上下文（里程碑 14~15）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 会话（session） | 一次完整的对话记录，保存在文件里，下次可以接着聊。 | [14](14-sessions/README.md) |
| JSONL（JSON Lines） | 每行一个 JSON 的文件格式。可以只往后追加；程序崩溃时，最多坏掉最后一行。 | [14](14-sessions/README.md) |
| 只追加（append-only） | 只在文件末尾添加，从不修改已有的内容。 | [14](14-sessions/README.md) |
| `parentId` | 每条记录指向它的上一条，所有记录连成一棵树。不删除任何东西，就能"回到过去"。 | [14](14-sessions/README.md) |
| `AgentSession` | 夹在界面和 agent 之间的一层：保存会话、压缩上下文、自动重试。界面只和它打交道。 | [14](14-sessions/README.md) |
| 压缩（compaction） | 对话快装不下时，让模型把旧的部分写成一份总结，用总结代替原来的消息。 | [15](15-compaction/README.md) |
| token 估算 | 发请求之前估计对话有多少 token：服务商上一次报告的用量，加上之后新增内容的估算（按字符数）。 | [15](15-compaction/README.md) |
| 切分点（cut point） | 压缩时新旧两部分的分界。不能把一个工具调用和它的结果分开。 | [15](15-compaction/README.md) |

## 精致的终端界面（里程碑 16~19）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| ANSI 转义序列（escape sequence） | 以 `ESC`（`\x1b`）开头的特殊字符串。终端不显示它，而是执行它代表的动作：变色、移动光标、清除一行。 | [16](16-terminal/README.md) |
| CSI | `ESC [`，大多数转义序列的开头。 | [16](16-terminal/README.md) |
| SGR | 以 `m` 结尾的转义序列，设置颜色和样式，比如 `\x1b[31m`（红色）、`\x1b[0m`（恢复默认）。 | [16](16-terminal/README.md) |
| 原始模式（raw mode） | 终端不再等你按回车，也不替你处理 Ctrl+C，每按一个键程序就立刻收到。 | [16](16-terminal/README.md) |
| 按键序列 | 一次按键送给程序的字节。普通字母就是它自己，方向键、功能键是一串转义序列。 | [16](16-terminal/README.md) |
| 括号粘贴模式（bracketed paste） | 终端用特殊的标记把粘贴的内容包起来，程序就能区分"粘贴"和"打字"。 | [16](16-terminal/README.md) |
| 显示宽度 | 一段文字在终端里占几列。汉字和大部分 emoji 占 2 列，所以 `"你好".length` 是 2，宽度却是 4。 | [16](16-terminal/README.md) |
| 字形簇（grapheme cluster） | 用户眼里的"一个字符"，可能由好几个码点组成，比如带肤色的 emoji。删除、移动光标都以它为单位。 | [16](16-terminal/README.md) |
| TUI | terminal user interface，在终端里画出来的界面。 | [17](17-tui/README.md) |
| 组件（component） | 界面的一块，`render(width)` 返回几行文字。整个界面是由组件组成的一棵树。 | [17](17-tui/README.md) |
| 差分渲染（differential rendering） | 比较新旧两帧，只重画变化了的行，所以不闪烁。 | [17](17-tui/README.md) |
| 主屏幕、备用屏幕 | 终端的两个画面。mini-pi 和 pi 画在主屏幕上，滚出去的内容进入终端的历史记录，可以往回翻；vim 这类程序用备用屏幕。 | [17](17-tui/README.md) |
| 宽度契约 | 组件返回的每一行都不能比终端宽，否则终端会自动折行，差分渲染就乱了。 | [17](17-tui/README.md) |
| 同步输出（synchronized output） | 告诉终端"先别显示，等我画完一整帧"，避免看到画了一半的画面。 | [17](17-tui/README.md) |
| 光标标记（cursor marker） | 组件在输出里放一个看不见的标记，框架把终端真正的光标移到那里，输入法的候选词窗口才会出现在正确的位置。 | [17](17-tui/README.md) |
| 输入法（IME） | 用来输入中文等文字的程序，在光标的位置显示候选词。 | [17](17-tui/README.md) |
| 节流（throttle） | 限制频率：短时间内的很多次重画请求合并成一次，每秒最多画 60 次。 | [17](17-tui/README.md) |
| 焦点（focus） | 当前接收按键的那个组件。 | [17](17-tui/README.md) |
| 快捷键表（keybindings） | 把"动作"（比如 `input.submit`）和"按键"（比如 `enter`）分开，用户可以在设置里改按键。 | [18](18-editor/README.md) |
| 逻辑行、屏幕行 | 编辑器里用换行符分开的行；自动折行之后屏幕上显示的行。一个逻辑行可能占好几个屏幕行。 | [18](18-editor/README.md) |
| 记忆列（preferred column） | 上下移动光标时记住原来的列，经过一个短的行之后，还能回到原来的列。 | [18](18-editor/README.md) |
| 分词 | 把文字切成词。`Intl.Segmenter` 能给中文分词，按词移动光标就靠它。 | [18](18-editor/README.md) |
| Markdown | 用简单的符号表示格式的文本：`**粗体**`、`# 标题`、代码块。模型的回答一般是 Markdown。 | [18](18-editor/README.md) |
| 事件驱动（event-driven） | 界面不主动去查 agent 的状态，而是收到事件时更新自己。 | [19](19-interactive/README.md) |

## 毕业（里程碑 20~22）

| 术语 | 解释 | 见 |
| --- | --- | --- |
| 自动重试（retry） | 临时性的错误（429、5xx、网络问题）等一会儿再试；永久性的错误（401、400、额度用完）不重试。 | [20](20-polish/README.md) |
| 指数退避（exponential backoff） | 每失败一次，等待的时间翻倍：2 秒、4 秒、8 秒。 | [20](20-polish/README.md) |
| 上下文超限（context overflow） | 请求超出了模型的上下文窗口而被拒绝。恢复的办法：压缩，然后重试一次。 | [20](20-polish/README.md) |
| 设置文件（settings） | `~/.mini-pi/settings.json`：默认的模型、快捷键、压缩和重试的参数。 | [20](20-polish/README.md) |
| 斜杠命令（slash command） | 以 `/` 开头的命令，比如 `/model`、`/help`，由程序自己处理，不发给模型。 | [20](20-polish/README.md) |
| monorepo | 一个 git 仓库里放着好几个包。pi 就是这样组织的。 | [21](21-read-pi/README.md) |
| 扩展（extension） | pi 启动时加载的 TypeScript 文件，可以注册命令和工具、监听事件。 | [21](21-read-pi/README.md) |
| 技能（skill） | 按需加载的说明：系统提示词里只放每个技能的一句话简介，模型需要时再去读完整的内容。 | [21](21-read-pi/README.md) |
| MCP（Model Context Protocol） | 让 agent 连接外部"工具服务器"的标准协议。 | [21](21-read-pi/README.md) |
| 验收测试（acceptance test） | 只从外面检查程序行为的测试，不关心代码怎么写。毕业项目用它检查你的 mini-pi。 | [22](22-capstone/README.md) |
