# 常见问题

遇到问题，先读报错信息：第一行说的是什么错误，调用栈里第一个属于你自己代码的位置在哪里（[里程碑 00 第 8 节](00-setup/README.md)）。

每一章的"常见错误"一节，列的是那一章特有的问题。这里收集的是跨章节的问题：安装、网络、API key、终端、测试。

## 1. Node 和 TypeScript

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `node: command not found` 或 `command not found: node` | 没有安装 Node；或者装好了，但终端是安装之前打开的 | 重新打开终端。用 fnm 安装的，运行 `fnm use 24`。见[里程碑 00 第 4 节](00-setup/README.md) |
| `Unknown file extension ".ts"` | Node 版本太旧，不能直接运行 `.ts` 文件 | `node --version` 要是 22.18 或更高，推荐 24 |
| `TypeScript enum is not supported in strip-only mode` | 用了不能简单删除的 TypeScript 语法：`enum`、`namespace`、构造函数的参数属性…… | 用联合类型代替 `enum`；在类里显式声明字段，在构造函数里赋值 |
| `Cannot find module '.../xxx' imported from ...` | `import` 的路径少了 `.ts` 后缀，或者路径写错了 | 写完整：`import { x } from "./xxx.ts"` |
| `[MODULE_TYPELESS_PACKAGE_JSON] Warning` | `package.json` 里没有 `"type": "module"` | 加上它 |
| `npm install` 很慢或者失败 | 网络问题 | 设置镜像：`npm config set registry https://registry.npmmirror.com` |
| `npm run check` 提示找不到 `tsc` | 还没有安装开发依赖 | 在项目目录里运行 `npm install` |
| 程序能运行，`npm run check` 却报了一堆错 | Node 运行时不检查类型 | 正常现象："运行"和"类型检查"是两件事（[里程碑 00 第 6.3 节](00-setup/README.md)）。按报错改 |
| Windows 上 `bash` 工具和测试失败 | Windows 原生没有 bash | 使用 WSL2（[里程碑 00 第 2 节](00-setup/README.md)） |

## 2. 网络和 API key

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `fetch failed`，原因是 `ECONNREFUSED` | 那个地址上没有服务：假模型服务器没启动，或者端口不对 | 先启动 `node learn/tools/fake-llm/server.ts`，检查 `LLM_BASE_URL` 里的端口 |
| `fetch failed`，原因是 `ENOTFOUND` | 域名写错了，或者没联网 | 检查地址，用浏览器打开试试 |
| 请求很久没反应，最后超时 | 访问国外的服务商需要代理 | 见下面的"使用代理" |
| `HTTP 401` | key 不对、过期了、多了空格或引号；或者 key 和服务商对不上（比如用 DeepSeek 的 key 访问 OpenAI） | 重新复制 key；检查 `.env` 里没有多余的引号和空格 |
| `HTTP 402`，或者提示余额不足 | 账户没钱了 | 充值 |
| `HTTP 404` | 地址不对（多了或少了 `/v1`），或者模型名写错了 | 对照服务商的文档 |
| `HTTP 400` | 请求的格式不对：模型名错了、参数不支持、消息的顺序不合法（比如有工具结果，却没有对应的工具调用） | 读错误信息的详细内容；用假模型服务器加 `--verbose`，看看你的程序发出去的完整请求 |
| `HTTP 429` | 请求太频繁，或者额度用完了 | 等一会儿再试；错误信息里有 quota、余额之类的字样，说明是额度用完了 |
| `HTTP 500`、`503`、`overloaded` | 服务器的问题 | 等一会儿再试。里程碑 20 之后，mini-pi 会自动重试 |

**使用代理。** Node 自带的 `fetch` 默认**不读取** `HTTPS_PROXY` 环境变量：就算终端里设置了代理，请求也是直接发出去的。较新的 Node（22.21 以上，或者 24）可以再加一个环境变量，让 `fetch` 使用代理：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890   # 换成你自己的代理地址
export NODE_USE_ENV_PROXY=1
```

更省事的办法是选择国内的服务商（DeepSeek、通义千问、Kimi、智谱），或者用 Ollama 在自己的电脑上运行模型（地址是 `http://localhost:11434/v1`，key 随便填）。

**API key 泄露了怎么办。** 不小心把 key 提交到了 git、贴到了网上：**马上到服务商的控制台删除这个 key，再新建一个**。只删除提交记录是不够的：推送到网上的内容可能早就被看到了，有专门的程序在扫描公开仓库里的 key。

## 3. 运行 mini-pi 和假模型服务器

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `listen EADDRINUSE: address already in use 127.0.0.1:4000` | 已经有一个假模型服务器在运行（可能在另一个终端窗口里） | 直接用那一个；或者换一个端口 `--port 4001`，`LLM_BASE_URL` 也跟着改 |
| 假模型服务器返回 500，提示"剧本不够长" | 剧本模式下，预设的回复用完了 | 在剧本里多加几条回复 |
| 假模型不调用工具，只是复读 | 请求里没有带工具，或者你说的话不在它的规则表里 | 看[假模型服务器的说明](tools/fake-llm/README.md)；加 `--verbose`，看请求里有没有 `tools` |
| 真正的模型不调用工具，而是让你自己去做 | 工具的说明不清楚，或者系统提示词里没有说清楚它能做什么 | 检查发出去的工具定义和系统提示词；换一个能力更强的模型 |
| `-c` 说没有可以继续的会话 | 会话是按工作目录保存的，你换了目录 | 回到原来的目录再运行 |
| 设置好像没有生效 | 设置文件有错误，整个文件都被忽略了 | 看启动时的提示，或者在交互模式里输入 `/settings` |
| 没有加 `-p`，却进入了 print 模式 | 输入或输出被管道连接时（比如 `mini-pi \| tee log.txt`），会自动使用 print 模式 | 直接在终端里运行 |

## 4. 终端界面

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 程序退出或崩溃之后，打字不显示、回车不换行 | 终端还停留在原始模式 | 盲打 `reset`，再按回车 |
| 界面上有乱码或者方框 | 终端的字体里没有这个字符，或者终端太旧 | 换一个较新的终端和等宽字体 |
| Alt + 某个键没有反应 | macOS 的终端默认不把 Option 键当作 Alt | 终端（Terminal.app）：设置 → 描述文件 → 键盘 → 勾选"将 Option 键用作 Meta 键"。iTerm2：Settings → Profiles → Keys → Left Option key 选 `Esc+` |
| Shift+Enter 没有换行，而是把消息发送了 | 大多数终端分不清 Shift+Enter 和 Enter | 用 Alt+Enter 或 Ctrl+J 换行，或者在行尾输入 `\` 再按回车 |
| 在 VS Code 的终端里，有的快捷键没有反应 | 被 VS Code 自己用掉了 | 换一个独立的终端，或者在设置文件里换一个快捷键 |
| 报错"第 N 行有 X 列，超过了终端的宽度" | 某个组件返回的行比终端宽 | 找到是哪个组件，用 `truncateToWidth()` 或 `wrapText()` 处理（[里程碑 17 第 2.3 节](17-tui/README.md)） |
| 输入中文时，候选词窗口不在光标旁边 | 有焦点的组件没有输出光标标记 | 见[里程碑 17 第 4 节](17-tui/README.md) |
| 汉字或 emoji 后面的光标错位 | 显示宽度算错了；也可能是终端自己对某些 emoji 宽度的判断和我们不同 | 检查 `visibleWidth`。少数 emoji 在不同终端里宽度不一样，这是已知的限制 |
| 界面闪烁 | 每次都全部重画了；或者终端不支持同步输出 | 检查差分渲染（[里程碑 17 第 3 节](17-tui/README.md)）；换一个较新的终端 |
| 界面完全乱了（比如在某些编辑器内置的简易终端里） | 终端不支持需要的转义序列 | 加 `--plain` 使用逐行模式。`TERM=dumb` 时会自动使用逐行模式 |

## 5. 测试

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 测试的数量比 README 里说的多几个 | 直接运行 `node --test`，把 `test/helpers/` 里的辅助文件也当成了测试 | 用 `npm test`，它只运行 `test/*.test.ts` |
| 测试在你的电脑上失败，换个终端就好了 | 你的环境变量（比如 `LLM_BASE_URL`、`MINI_PI_MODEL`）影响了程序 | 在测试里显式传入需要的配置，不依赖外面的环境变量；或者先 `unset` 它们 |
| 测试运行完了，进程却不退出 | 有服务器没关、定时器没清除、子进程还在运行 | 用 `t.after(() => server.close())` 收尾；`clearTimeout`；确认子进程都结束了 |
| 课程的检查脚本检查的是参考答案，不是你的代码 | 没有设置 `MY_PI` | `MY_PI=~/my-pi node --test learn/05-streaming/check.test.ts` |
| 只想运行某一个测试 | | `node --test --test-name-pattern="测试名字的一部分" test/xxx.test.ts` |

## 6. git

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `git status` 里出现了 `.env` | `.gitignore` 里没有 `.env` | 把 `.env` 加进 `.gitignore`。已经提交过的，见上面的"API key 泄露了怎么办" |
| 改坏了，想回到上一次提交的样子 | | 某个文件：`git restore 文件名`。先用 `git diff` 看清楚改了什么，恢复之后就找不回来了 |
| 想看看自己上一次是怎么写的 | | `git log --oneline` 找到那次提交，`git show 提交号:文件名` |

## 7. 还是解决不了

1. **缩小问题。** 新建一个最小的文件，只保留能重现问题的几行代码。很多时候，缩小到一半问题就自己现形了。
2. **搜索报错信息。** 把报错的关键部分（去掉你自己的文件名和路径）放进搜索引擎。
3. **对照参考答案。** 用 `diff -r ~/my-pi/src learn/<里程碑>/code/src` 或者 VS Code 的"比较文件"，找出你的代码和参考答案的不同。
4. **查官方文档。** [Node.js 文档](https://nodejs.org/docs/latest/api/)、[MDN](https://developer.mozilla.org/zh-CN/)、服务商的 API 文档。
5. **休息一下。** 第二天再看，常常一眼就看出问题了。
